-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1789 (#715 / 問い合わせ #1788 要望①): 欲しいカードの枚数指定。
-- 「渡す特定の1枚 ⇄ 欲しいカード種別 × N枚」を表現できるようにする。
--
-- 方針(expand のみ・加法的変更):
--   - trade_offers.wanted_quantity を追加する。既定値1なので既存行・旧アプリが
--     作る行は従来どおり1:1のまま。旧アプリは列を知らなくても動き、新アプリは
--     migration 未適用の窓(planetscale-migrate とアプリデプロイが非同期)では
--     src/lib/trade.ts のフォールバックで「全オファー1枚」として縮退する。
--   - accept_trade_offer は同じ引数シグネチャのまま CREATE OR REPLACE し、
--     応諾者のコピーを wanted_quantity 枚まとめて移転する。旧アプリから呼ばれても
--     (列の既定値が1のため)従来と同じ1枚移転になる。返却JSONの既存キーは
--     すべて維持する(givenUserCardId は移転したうちの最古の1枚)。
--   - 渡す側の複数枚(譲 A×N)は #1789 のスコープ外。
--
-- 上限 10 は src/lib/trade.ts の TRADE_MAX_WANTED_QUANTITY と一致させる。
-- CHECK を DB にも置くのは、API 層の入力検証を経ない書き込み経路(手動SQL・
-- 将来の別経路)でも、応諾時に応諾者の手持ちを無制限に要求する行を作れなく
-- するため(防御的多重化)。

ALTER TABLE public.trade_offers
  ADD COLUMN wanted_quantity smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT trade_offers_wanted_quantity_range
    CHECK (wanted_quantity BETWEEN 1 AND 10);

COMMENT ON COLUMN public.trade_offers.wanted_quantity IS
  '応諾者が渡す wanted_card_id のコピー枚数(1〜10)。成立時は accept_trade_offer が最古の N 枚をまとめて移転する。accepted_user_card_id にはそのうち最古の1枚だけを記録する(残りは offerer の user_cards に card_id=wanted_card_id, obtained_at=completed_at で残る)。';

-- 20260817100000_add_card_trading.sql の accept_trade_offer を N 枚対応にする。
-- 変更点は「3. 応諾者の支払いカード選択」と「4. 所有権移転」だけで、
-- ロック順(オファー行 → 出品者の user_cards 行 → 応諾者の支払い user_cards 行)・
-- 冪等リプレイ・エラーコード JSONB 方式・設定ゲートは元の実装と同一。
-- 各判断の詳しい理由は元 migration のコメントを参照。
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
  v_payer_user_card_ids uuid[];
  v_payer_locked_count integer;
  v_payer_update_count integer;
BEGIN
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

  -- 2. 冪等リプレイ判定(すべての検証より前)
  IF v_offer.status = 'completed'
     AND v_offer.accepted_by_user_id = v_user_id
     AND v_offer.accepted_request_id = p_request_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'tradeOfferId', v_offer.id,
      'receivedUserCardId', v_offer.offered_user_card_id,
      'givenUserCardId', v_offer.accepted_user_card_id,
      'offeredCardSnapshot', v_offer.offered_card_snapshot,
      'wantedCardSnapshot', v_offer.wanted_card_snapshot,
      'completedAt', v_offer.completed_at,
      'idempotentReplay', true
    );
  END IF;

  -- 3. 検証(業務上あり得る失敗はエラーコード入り JSONB で返す)
  IF v_offer.status <> 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_OPEN');
  END IF;

  IF v_offer.offerer_user_id = v_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'SELF_ACCEPT_FORBIDDEN');
  END IF;

  IF v_offer.offered_card_id IS NULL OR v_offer.wanted_card_id IS NULL THEN
    UPDATE public.trade_offers SET status = 'cancelled' WHERE id = p_trade_offer_id;
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_INVALID');
  END IF;

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

  -- 出品カード実在チェック(ロック順2番目)
  SELECT id INTO v_offered_card_owner_check
  FROM user_cards
  WHERE id = v_offer.offered_user_card_id
    AND user_id = v_offer.offerer_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.trade_offers SET status = 'cancelled' WHERE id = p_trade_offer_id;
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_INVALID');
  END IF;

  -- 応諾者の支払いカード選択(ロック順3番目)。3段構成:
  --   (1) 候補コピーを LIMIT なしで全ロック(元実装と同じ。並行応諾を直列化する)
  --   (2) ロック確定後に obtained_at, id の昇順で最古の wanted_quantity 枚を選定
  --   (3) 選定した行を改めて FOR UPDATE し、ロック後の所有者で枚数を数え直す
  -- 元実装は1枚だったため (2) の選定行を条件付き UPDATE の ROW_COUNT=0 で
  -- fail-closed できたが、N枚では「一部だけ UPDATE 済み」の状態で JSONB を返すと
  -- 部分移転がコミットされてしまう。(1) と (2) の間に第三のトランザクションが
  -- 新規コピーを commit した場合、そのコピーは (1) のロック対象外なので、
  -- (3) で選定行すべてをロックしてから数え直し、N 枚そろわなければ何も
  -- 書き込まないうちに CARD_NOT_OWNED を返す。(3) のロックは選定行を id 順に
  -- 取る(ORDER BY id)ことで、同じ応諾者の並行応諾どうしのロック順を固定する。
  -- 自分が open オファーとして出品中のコピーは二重譲渡になるため候補から除外する。
  PERFORM 1
  FROM user_cards
  WHERE user_id = v_user_id
    AND card_id = v_offer.wanted_card_id
    AND id NOT IN (
      SELECT offered_user_card_id FROM public.trade_offers
      WHERE offerer_user_id = v_user_id AND status = 'open'
    )
  FOR UPDATE;

  -- (2) は意図的に FOR UPDATE を付けない(LIMIT + FOR UPDATE はロック待ち中に
  -- 対象行が条件を外れても次点へ繰り上がらないため。元 migration の注記参照)。
  SELECT array_agg(candidate.id ORDER BY candidate.obtained_at ASC, candidate.id ASC)
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
  ) AS candidate;

  IF COALESCE(array_length(v_payer_user_card_ids, 1), 0) < v_offer.wanted_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_OWNED');
  END IF;

  -- (3) 選定行のロックと数え直し。ロック後の行は commit まで他トランザクションに
  -- 所有者を変えられないため、この count が直後の UPDATE の対象行数と一致する。
  PERFORM 1
  FROM user_cards
  WHERE id = ANY (v_payer_user_card_ids)
    AND user_id = v_user_id
  ORDER BY id
  FOR UPDATE;

  SELECT count(*) INTO v_payer_locked_count
  FROM user_cards
  WHERE id = ANY (v_payer_user_card_ids)
    AND user_id = v_user_id;

  IF v_payer_locked_count <> v_offer.wanted_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_OWNED');
  END IF;

  -- 4. 所有権移転(支払い側を先に更新。row-per-copy なので user_id の付け替え)
  UPDATE user_cards SET user_id = v_offer.offerer_user_id, obtained_at = now()
    WHERE id = ANY (v_payer_user_card_ids) AND user_id = v_user_id;
  GET DIAGNOSTICS v_payer_update_count = ROW_COUNT;

  -- (3) のロック下では到達しない防御。ここで JSONB を返すと部分移転が
  -- コミットされうるため、例外でトランザクション全体を巻き戻す。
  IF v_payer_update_count <> v_offer.wanted_quantity THEN
    RAISE EXCEPTION 'TRADE_PAYER_TRANSFER_MISMATCH';
  END IF;

  UPDATE user_cards SET user_id = v_user_id, obtained_at = now()
    WHERE id = v_offer.offered_user_card_id;

  -- 5. オファーを completed に更新
  UPDATE public.trade_offers SET
    status = 'completed',
    accepted_by_user_id = v_user_id,
    accepted_user_card_id = v_payer_user_card_ids[1],
    accepted_request_id = p_request_id,
    completed_at = now()
  WHERE id = p_trade_offer_id;

  RETURN jsonb_build_object(
    'success', true,
    'tradeOfferId', v_offer.id,
    'receivedUserCardId', v_offer.offered_user_card_id,
    'givenUserCardId', v_payer_user_card_ids[1],
    'offeredCardSnapshot', v_offer.offered_card_snapshot,
    'wantedCardSnapshot', v_offer.wanted_card_snapshot,
    'completedAt', now(),
    'idempotentReplay', false
  );
END;
$$;

COMMENT ON FUNCTION public.accept_trade_offer(text, uuid, uuid) IS
  'トレードオファーの応諾。応諾者の wanted_card_id コピーを wanted_quantity 枚まとめて移転する(#1789)。FOR UPDATE ロック+エラーコードJSONB返却でOFFER_INVALID系のcancelled更新をコミット可能にする。詳細はtasks/plans/issue-715-card-trading.md §4.4。';

-- CREATE OR REPLACE は既存の権限を保持するが、元 migration と同じく明示しておく。
REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid) TO service_role;
