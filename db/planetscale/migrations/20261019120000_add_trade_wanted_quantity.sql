-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1789 (問い合わせ #1788 要望①): トレードの欲しいカード枚数指定。
-- 「譲: 特定の1枚 ⇄ 求: 同じカード種別 ×N (N=1〜10)」を可能にする。
--
-- 20260817100000_add_card_trading.sql の trade_offers / accept_trade_offer を
-- 拡張する。本migrationで既存の open/completed/cancelled 行はすべて
-- wanted_quantity=1(既定値)になるため、既存オファーの表示・応諾は変化しない
-- (のちのPRで追加された1:1フローの後方互換)。
--
-- 変更点:
-- 1. trade_offers.wanted_quantity (NOT NULL DEFAULT 1, CHECK 1..10) を追加。
--    応諾の成立条件(応諾者が N 枚支払えるか)と表示(×N)の正本データ。
-- 2. trade_offers.accepted_user_card_ids (uuid[] NOT NULL DEFAULT '{}') を追加。
--    accepted_user_card_id は後方互換のため「選定した最古の1枚」のまま残し、
--    N>1 のときは全コピーをこちらの配列に記録する(completed 行=履歴の完全性)。
-- 3. accept_trade_offer() を CREATE OR REPLACE: 支払いコピーの選定を
--    「最古の1枚」→「最古のN枚(id順ロック)」に拡張する。
--    検証をどれか外れても部分成立させない(全数揃わなければ何も移転しない)。
--
-- Supabase側: supabase/migrations/ にはトレード系テーブルが存在しない
-- (#691 PlanetScale移行後にトレード機能が追加されたため)。本変更も
-- Planetscale provider単独であり supabase/migrations への追加は不要。

-- ============================================================
-- 1. trade_offers に枚数列を追加
-- ============================================================
-- 上限10は TradeCreateForm のUI・レート制限(#728)・RMT対策(#729)と整合させる
-- 定数(ADR上は将来変更可能。CHECKで10を物理的に固定する)。
ALTER TABLE public.trade_offers
  ADD COLUMN wanted_quantity integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT trade_offers_wanted_quantity_range CHECK (wanted_quantity >= 1 AND wanted_quantity <= 10);

-- 成立したトレードで応諾者が支払った全user_cardsコピーの記録。
-- accepted_user_card_id(スカラー)との重複は後方互換保持のため許容する:
-- 既存の読者(UI・監査ログ)はスカラーを解釈し続けられる。配列は N>1 の
-- 履歴(マイトレード・不正調査#729)の完全性のために追加する。
-- FKは accepted_user_card_id と同じく張らない(行は後日DELETEされうるため)。
ALTER TABLE public.trade_offers
  ADD COLUMN accepted_user_card_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- ============================================================
-- 2. accept_trade_offer RPC 全体差し替え
-- ============================================================
-- 既存シグネチャ(text, uuid, uuid)・ロック順(オファー行→出品者の
-- user_cards行→応諾者のuser_cards行)・40P01リトライ契約(CI側で1回)・
-- 冪等リプレイ(同一acceptor+同一accepted_request_id)・JSONBエラーコード返却
-- ・cancelled更新のコミットはすべて維持する。
--
-- 支払いコピーの複数化(3.5〜3.8):
--   (a) 候補全ロック(PERFORM ... FOR UPDATE)は1枚版と同一(LIMITなし)。
--   (b) 最古のN枚を選定(ロックなし・ORDER BY obtained_at ASC, id ASC LIMIT N)。
--       N枚に満たなければ CARD_NOT_OWNED(部分成立しない)。
--   (c) 選定N枚を id 昇順で FOR UPDATE し直して所有権を再検証する。
--       stage-2のSELECTはロックを持たないため、選定後にコピーが消えた・
--       他者へ移ったケースはここで除去する(行数不足→CARD_NOT_OWNED)。
--       id 昇順の理由: 複数の並行acceptが重なり合う候補部分集合を異なる順序で
--       ロックするのはデッドロック(40P01)の温床になるため、本RPC内の
--       user_cards の複数行ロックは常に主キー昇順に固定する。
--   (d) 所有権移転の UPDATE は id 配列 + `AND user_id = v_user_id` 条件付きで
--       行数チェックを維持する(最終防御・1枚版と同じ多重化)。READ COMMITTED
--       のスナップショット境界で読めた新規コピーの所有権が(第三トランザクション
--       によって)変わっていた場合も、このチェックが0件(不足)を保証する。
CREATE OR REPLACE FUNCTION public.accept_trade_offer(
  p_twitch_user_id text,
  p_trade_offer_id uuid,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id uuid;
  v_offer public.trade_offers%ROWTYPE;
  v_offered_streamer_trade_enabled boolean;
  v_offered_streamer_cross_enabled boolean;
  v_wanted_streamer_trade_enabled boolean;
  v_wanted_streamer_cross_enabled boolean;
  v_offered_card_owner_check uuid;
  -- 応諾者が支払うN枚のコピー。取得順は (obtained_at ASC, id ASC)。
  v_payer_user_card_ids uuid[] := '{}'::uuid[];
  -- (c)のid昇順ロック検証を通過したコピー。原則 v_payer_user_card_ids と
  -- 同一集合(順序のみ昇順id)。検証で落ちた行があった場合この時点で失敗する。
  v_payer_locked_ids uuid[] := '{}'::uuid[];
  v_payer_update_count integer;
BEGIN
  -- 引数欠落は呼び出し側(API層)の契約違反であり、通常運用では起こり得ない。
  -- 00060 の REQUEST_ID_REQUIRED / USER_NOT_FOUND と同じく RAISE EXCEPTION とする
  -- (エラーコードJSONB返却方式は、下記の「検証で失敗しても cancelled 更新だけは
  -- コミットしたい」業務検証専用)。
  IF p_twitch_user_id IS NULL OR p_trade_offer_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT id INTO v_user_id
  FROM users
  WHERE twitch_user_id = p_twitch_user_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- 1. オファー行をロック(ロック順の起点)
  SELECT * INTO v_offer
  FROM public.trade_offers
  WHERE id = p_trade_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRADE_OFFER_NOT_FOUND');
  END IF;

  -- 2. 冪等リプレイ判定(すべての検証より前に行う)。#1789 で givenUserCardIds /
  -- wantedQuantity をレスポンスへ追加したため、成立済み行についてもここで
  -- 再構成して返す(旧1:1行は accepted_user_card_ids = '{}' なので空配列を返す
  -- — リプレイは検証器(isValidTradeAcceptRpcResult)が空配列を許容する)。
  -- この行内の値照合だけで完結するため accepted_request_id にUNIQUE制約は付けない。
  IF v_offer.status = 'completed'
     AND v_offer.accepted_by_user_id = v_user_id
     AND v_offer.accepted_request_id = p_request_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'tradeOfferId', v_offer.id,
      'wantedQuantity', v_offer.wanted_quantity,
      'receivedUserCardId', v_offer.offered_user_card_id,
      'givenUserCardId', v_offer.accepted_user_card_id,
      'givenUserCardIds', CASE
        WHEN v_offer.accepted_user_card_id IS NULL THEN '[]'::jsonb
        WHEN coalesce(array_length(v_offer.accepted_user_card_ids, 1), 0) = 0
          THEN jsonb_build_array(v_offer.accepted_user_card_id)
        ELSE to_jsonb(v_offer.accepted_user_card_ids)
      END,
      'offeredCardSnapshot', v_offer.offered_card_snapshot,
      'wantedCardSnapshot', v_offer.wanted_card_snapshot,
      'completedAt', v_offer.completed_at,
      'idempotentReplay', true
    );
  END IF;

  -- 3. 検証。ここから先の失敗はすべて「業務上あり得る通常フロー」であり、
  -- RAISE EXCEPTIONではなくエラーコード入りJSONBを返す。理由: カード定義削除・
  -- 出品カード喪失の2パスは、検証失敗時に trade_offers を
  -- cancelled へ更新した上でエラーを返す必要があるが、RAISE EXCEPTIONは
  -- 呼び出し元のtransactionを巻き戻すため、その cancelled 更新自体が
  -- ロールバックされてしまう。他の検証も含め方式を統一し、呼び出し側は常に
  -- JSONBの'error'キーの有無だけを見ればよい単純な契約にする。

  -- 二重成立防止。冪等リプレイに該当しない completed / cancelled は
  -- 「既に別の応諾で処理済み」として拒否する。
  IF v_offer.status <> 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_OPEN');
  END IF;

  -- 自己応諾禁止
  IF v_offer.offerer_user_id = v_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'SELF_ACCEPT_FORBIDDEN');
  END IF;

  -- カード定義が削除済み(ON DELETE SET NULLでNULL化)のオファーは成立不能
  IF v_offer.offered_card_id IS NULL OR v_offer.wanted_card_id IS NULL THEN
    UPDATE public.trade_offers SET status = 'cancelled' WHERE id = p_trade_offer_id;
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_INVALID');
  END IF;

  -- 設定ゲート再チェック(作成時だけでなく成立時にも必須。設定オフ後の
  -- 既存openオファーはここで拒否される。オファー自体は削除・cancelしない
  -- ため、再度trade_enabledがtrueに戻れば応諾可能に戻る)
  SELECT trade_enabled, cross_channel_trade_enabled
    INTO v_offered_streamer_trade_enabled, v_offered_streamer_cross_enabled
    FROM public.streamers WHERE id = v_offer.offered_streamer_id;
  SELECT trade_enabled, cross_channel_trade_enabled
    INTO v_wanted_streamer_trade_enabled, v_wanted_streamer_cross_enabled
    FROM public.streamers WHERE id = v_offer.wanted_streamer_id;

  IF NOT COALESCE(v_offered_streamer_trade_enabled, false)
     OR NOT COALESCE(v_wanted_streamer_trade_enabled, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRADE_DISABLED');
  END IF;

  IF v_offer.is_cross_channel
     AND (NOT COALESCE(v_offered_streamer_cross_enabled, false)
          OR NOT COALESCE(v_wanted_streamer_cross_enabled, false)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRADE_DISABLED');
  END IF;

  -- 出品カード実在チェック(ロック順2番目: 出品者のuser_cards行)。
  -- 行が存在しない(削除済み)または所有者が変わっている場合は
  -- offerを cancelled に更新して 'OFFER_INVALID' を返す。
  SELECT id INTO v_offered_card_owner_check
  FROM user_cards
  WHERE id = v_offer.offered_user_card_id
    AND user_id = v_offer.offerer_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.trade_offers SET status = 'cancelled' WHERE id = p_trade_offer_id;
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_INVALID');
  END IF;

  -- 応諾者の支払い候補の全ロック(ロック順3番目: 応諾者のuser_cards行)。
  -- 1枚版と同一の2段構成: (1) 候補コピーをLIMITなしで全ロック、
  -- (2) ロック確定後に選定。自分がopenオファーとして出品中のコピーは、
  -- 成立すれば二重譲渡になるため候補から除外する。
  PERFORM 1
  FROM user_cards
  WHERE user_id = v_user_id
    AND card_id = v_offer.wanted_card_id
    AND id NOT IN (
      SELECT offered_user_card_id FROM public.trade_offers
      WHERE offerer_user_id = v_user_id AND status = 'open'
    )
  FOR UPDATE;

  -- (b) 最古のN枚を選定(ロックなし)。1枚版のSELECTと同じ理由: 「LIMIT付き +
  -- FOR UPDATE」の単一クエリだとロック待ち中に行が条件を外れた場合に次点へ
  -- 繰り上がらない問題があるため、選定はロックなしSELECTとし、移転側を
  -- 条件付き・行数チェック付きにして最終防御する((c)(d)参照)。
  -- 並び順は obtained_at ASC, id ASC(「最古コピー優先」ポリシーは
  -- 1枚版と同じ)。N枚に満たなければ CARD_NOT_OWNED を返し何も移転させない。
  SELECT coalesce(array_agg(id ORDER BY obtained_at ASC, id ASC), '{}'::uuid[])
    INTO v_payer_user_card_ids
    FROM (
      SELECT id, obtained_at
      FROM user_cards
      WHERE user_id = v_user_id
        AND card_id = v_offer.wanted_card_id
        AND id NOT IN (
          SELECT offered_user_card_id FROM public.trade_offers
          WHERE offerer_user_id = v_user_id AND status = 'open'
        )
      ORDER BY obtained_at ASC, id ASC
      LIMIT v_offer.wanted_quantity
    ) AS oldest_candidates;

  IF coalesce(array_length(v_payer_user_card_ids, 1), 0) <> v_offer.wanted_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_OWNED');
  END IF;

  -- (c) 選定したN枚を主キー昇順で再ロックし、このタイミングでのコピーの
  -- 消失・所有権変化を検出する。stage-1のPERFORMで既にロックを持つ行は
  -- ここでは再ロックコストはほぼ0であり、(PERFORMとこのSELECTの間に
  -- commitした)gap追加コピーの所有権変更のみがここで除外されうる。
  -- 除外された行数が不足した場合は直ちに CARD_NOT_OWNED(fail-closed、
  -- この時点で副作用なし)。
  SELECT coalesce(array_agg(id), '{}'::uuid[])
    INTO v_payer_locked_ids
    FROM (
      SELECT id
      FROM user_cards
      WHERE id = ANY(v_payer_user_card_ids)
        AND user_id = v_user_id
        AND card_id = v_offer.wanted_card_id
        AND id NOT IN (
          SELECT offered_user_card_id FROM public.trade_offers
          WHERE offerer_user_id = v_user_id AND status = 'open'
        )
      ORDER BY id
      FOR UPDATE
    ) AS id_ordered_payers;

  IF coalesce(array_length(v_payer_locked_ids, 1), 0) <> v_offer.wanted_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_OWNED');
  END IF;

  -- 4. 所有権移転(row-per-copyなのでUPDATEでuser_idを付け替える。新規発行では
  -- ないためmax_issuance_countには影響せず、card_owner_statsトリガー(00051)は
  -- OLD/NEW双方を再集計するためuser_id付け替えと整合する)。
  --
  -- 支払いカード側を先に更新する(出品カード側より先)。UPDATEは(c)で
  -- id昇順にロック済みのN枚に対し、`AND user_id = v_user_id` 条件付きで
  -- 実行する(1枚版と同じ最終防御。READ COMMITTEDのスナップショット境界で
  -- stage-1/-2/-3をまたいで存在したgapコピーの所有権が変わっていた場合も、
  -- 更新行数がNに満たない。単一UPDATEを GROUP BY なしで実行するため、
  -- ロック順はインデックススキャン順 = 配列内id順を選択する)。0枚/不足なら
  -- 「選定後に何らかの経路で対象コピーの所有権が変わった」ことを意味する。
  -- この時点では出品カード側もオファー行のstatusも未更新のため、
  -- JSONBをRETURNすれば部分的な副作用は残らず安全にfail-closedする
  -- (RAISE EXCEPTIONによるロールバックを使わない)。
  UPDATE user_cards SET user_id = v_offer.offerer_user_id, obtained_at = now()
    WHERE id = ANY(v_payer_locked_ids) AND user_id = v_user_id;
  GET DIAGNOSTICS v_payer_update_count = ROW_COUNT;

  IF v_payer_update_count <> v_offer.wanted_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_OWNED');
  END IF;

  UPDATE user_cards SET user_id = v_user_id, obtained_at = now()
    WHERE id = v_offer.offered_user_card_id;

  -- 5. オファーをcompletedに更新。#1789: 支払った全コピーを
  -- accepted_user_card_ids へ記録する(accepted_user_card_id は引き続き
  -- 選定した最古の1枚)。accepted_request_id は冪等リプレイキーであるため
  -- 初回成立時にのみ書かれる(リプレイ応答はヘッダ行を更新せず再構成する)。
  UPDATE public.trade_offers SET
    status = 'completed',
    accepted_by_user_id = v_user_id,
    accepted_user_card_id = v_payer_user_card_ids[1],
    accepted_user_card_ids = v_payer_user_card_ids,
    accepted_request_id = p_request_id,
    completed_at = now()
  WHERE id = p_trade_offer_id;

  RETURN jsonb_build_object(
    'success', true,
    'tradeOfferId', v_offer.id,
    'wantedQuantity', v_offer.wanted_quantity,
    'receivedUserCardId', v_offer.offered_user_card_id,
    'givenUserCardId', v_payer_user_card_ids[1],
    'givenUserCardIds', to_jsonb(v_payer_user_card_ids),
    'offeredCardSnapshot', v_offer.offered_card_snapshot,
    'wantedCardSnapshot', v_offer.wanted_card_snapshot,
    'completedAt', now(),
    'idempotentReplay', false
  );
END;
$$;

COMMENT ON TABLE public.trade_offers IS
  'カードトレードのオープンオファー(掲示板方式)。completed行がそのままトレード履歴になる(別テーブルは作らない、YAGNI)。wanted_quantity=1..10は求めるコピー枚数、accepted_user_card_idsは成立時の支払いコピー全件。';

COMMENT ON FUNCTION public.accept_trade_offer(text, uuid, uuid) IS
  'トレードオファーの応諾。FOR UPDATE 2段ロック+エラーコードJSONB返却でOFFER_INVALID系のcancelled更新をコミット可能にする。#1789: 最古のwanted_quantity枚をid昇順ロックして一括移転する(不足時は部分成立しない)。詳細はtasks/plans/issue-715-card-trading.md §4.4。';

-- ============================================================
-- 3. アクセス制御(db/planetscale/grants.sqlのALTER DEFAULT PRIVILEGESで
-- 自動付与されるが、20260817100000と同じく明示しておく防御的多重化)
-- ============================================================
REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid) TO service_role;
