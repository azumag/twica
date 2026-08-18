-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #722 (#715 子2): トレード機能のDB基盤。
-- trade_offers テーブル + streamers 設定カラム + accept_trade_offer RPC。
-- 設計の正本は tasks/plans/issue-715-card-trading.md §3, §4。
--
-- Supabase時代からのPlanetScale方針転換に関する注記(レビュアー向け):
-- Issue #722本文・上記設計ドキュメントは RLS (`ENABLE ROW LEVEL SECURITY` +
-- `CREATE POLICY ... TO service_role`) と RPC への `SECURITY DEFINER
-- SET search_path = public, pg_temp` を指示しているが、これは #691でのPlanetScale
-- 移行完了(twica_app が BYPASSRLS を持つ)より前に書かれた設計であり、本migrationは
-- 現行の db/planetscale/grants.sql の方針に合わせて意図的に踏襲していない:
--   - RLS: twica_app は BYPASSRLS を持つため個々のテーブルのRLSポリシーは
--     一切評価されず、付けても実効性のない飾りになる(grants.sql 冒頭コメント参照)。
--   - SECURITY DEFINER: 特権昇格が目的の機構だが、呼び出しロール(twica_app)は
--     既に service_role 相当のフルアクセスを持つため昇格の必要が無い。
--     SET search_path 固定も、SECURITY DEFINER を使わない以上は search_path
--     汚染による権限昇格経路が存在せず不要。
-- アクセス制御は db/planetscale/migrations/20260725100000_transactional_chat_outbox.sql
-- と同じく末尾の明示的 REVOKE/GRANT (+ grants.sql の ALTER DEFAULT PRIVILEGES)で行う。

-- ============================================================
-- 1. trade_offers テーブル
-- ============================================================
-- 所有は row-per-copy モデル(user_cards 1行=1枚)なので、オファーは
-- 特定の user_cards 行を指す。
CREATE TABLE public.trade_offers (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  -- 出品者
  offerer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 渡すカードの特定の1枚。
  -- 意図的にFKを張らない: user_cards行はカードストーン交換RPC(exchange_duplicate_card_for_stones)
  -- 等でDELETEされうるため、FK CASCADEにすると completed 行(=トレード履歴)が
  -- 取引相手の後日の行動で消えてしまう。openオファーの整合性は下記の部分UNIQUE
  -- +応諾時の実在チェック(accept_trade_offer内)で担保する。
  offered_user_card_id uuid NOT NULL,
  -- 一覧表示・フィルタ用の非正規化。クライアントからは受け取らず、
  -- サーバが offered_user_card_id / wanted_card_id から導出してINSERTする。
  -- cards へのFKは ON DELETE SET NULL: 既存の DELETE /api/cards/[id] はカード定義を
  -- 無条件ハード削除するため、CASCADEにすると配信者のカード整理で completed 行
  -- (=トレード履歴)が消えてしまう(クロスチャンネルでは相手配信者の操作で
  -- 自分の履歴が消える)。表示は下記スナップショットにフォールバックする。
  offered_card_id uuid REFERENCES cards(id) ON DELETE SET NULL,
  offered_streamer_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  -- 欲しいカード(種別指定。特定の1枚ではない)
  wanted_card_id uuid REFERENCES cards(id) ON DELETE SET NULL,
  wanted_streamer_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  -- カード定義削除後も履歴表示できるよう、出品時に両カードの表示情報
  -- (name / rarity / image_url)をスナップショット保存する
  offered_card_snapshot jsonb NOT NULL,
  wanted_card_snapshot jsonb NOT NULL,
  -- チャンネル内/クロスの判別。生成列にして非正規化不整合を排除
  is_cross_channel boolean GENERATED ALWAYS AS (offered_streamer_id <> wanted_streamer_id) STORED,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  -- 成立情報(記録用。accepted_user_card_id もFKなし: 移転後も記録を残す)
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_user_card_id uuid,
  completed_at timestamptz,
  -- 冪等性キー: 作成用(request_id)と応諾用(accepted_request_id)を分離
  request_id uuid,
  accepted_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 同一カード同士の交換は無意味なので禁止
  -- (offered_card_id/wanted_card_idの片方がNULL(削除済み)の場合はNULL <> NULLが
  -- UNKNOWNになりCHECKを通過するが、その状態はaccept_trade_offer側のOFFER_INVALID
  -- 判定で成立を拒否するため実害はない)
  CONSTRAINT trade_offers_different_cards CHECK (offered_card_id <> wanted_card_id)
);

-- 同じ1枚を複数のopenオファーに同時出品することを防ぐ(部分UNIQUE。FKなしでも機能する)
CREATE UNIQUE INDEX idx_trade_offers_open_user_card
  ON public.trade_offers (offered_user_card_id) WHERE status = 'open';
-- 作成の冪等性
CREATE UNIQUE INDEX idx_trade_offers_offerer_request
  ON public.trade_offers (offerer_user_id, request_id) WHERE request_id IS NOT NULL;
-- 一覧クエリ用(created_at DESC ページネーションに直接使える複合部分インデックス)
CREATE INDEX idx_trade_offers_open_offered_streamer
  ON public.trade_offers (offered_streamer_id, created_at DESC) WHERE status = 'open';
CREATE INDEX idx_trade_offers_open_wanted_streamer
  ON public.trade_offers (wanted_streamer_id, created_at DESC) WHERE status = 'open';
-- 出品上限チェック・マイトレード「出品中」タブ用
CREATE INDEX idx_trade_offers_open_offerer
  ON public.trade_offers (offerer_user_id) WHERE status = 'open';
-- FKカスケード支持インデックス(00071の本番障害の教訓: 部分インデックスはカスケード
-- 削除の参照行検索に使えないため、カスケードFK列にはフルインデックスが別途要る)
CREATE INDEX idx_trade_offers_offerer_user_id ON public.trade_offers (offerer_user_id);
CREATE INDEX idx_trade_offers_offered_card_id ON public.trade_offers (offered_card_id);
CREATE INDEX idx_trade_offers_offered_streamer_id ON public.trade_offers (offered_streamer_id);
CREATE INDEX idx_trade_offers_wanted_card_id ON public.trade_offers (wanted_card_id);
CREATE INDEX idx_trade_offers_wanted_streamer_id ON public.trade_offers (wanted_streamer_id);
CREATE INDEX idx_trade_offers_accepted_by_user_id ON public.trade_offers (accepted_by_user_id);

-- updated_at 自動更新(00001 で定義済みの共通トリガー関数を再利用)
CREATE TRIGGER update_trade_offers_updated_at BEFORE UPDATE ON public.trade_offers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. streamers への設定カラム追加(デフォルトOFF・オプトイン)
-- ============================================================
ALTER TABLE public.streamers
  ADD COLUMN trade_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN cross_channel_trade_enabled boolean NOT NULL DEFAULT false;

-- ============================================================
-- 3. accept_trade_offer RPC
-- ============================================================
-- 成立処理は競合(同一オファーへの同時応諾、出品カードの喪失)があるため、
-- exchange_duplicate_card_for_stones(00059/00060)と同じ FOR UPDATE ロック +
-- 冪等性キーパターンで実装する。ロック順は「オファー行→出品者の user_cards 行→
-- 応諾者の支払い user_cards 行」で固定し、この順序を守らない経路を追加しないこと。
CREATE FUNCTION public.accept_trade_offer(
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
  v_payer_user_card_id uuid;
  v_payer_update_count integer;
BEGIN
  -- 引数欠落は呼び出し側(API層)の契約違反であり、通常運用では起こり得ない。
  -- 00060 の REQUEST_ID_REQUIRED / USER_NOT_FOUND と同じく RAISE EXCEPTION とする
  -- (エラーコードJSONB返却方式は、下記の「検証で失敗しても cancelled 更新だけは
  -- コミットしたい」業務検証専用。これらの契約違反には適用しない)。
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

  -- 2. 冪等リプレイ判定(すべての検証より前に行う)。
  -- 00060 と同じく、成立後にレスポンスをロストしたクライアントの再送が
  -- 「二重成立防止」検証(status='open')に引っかかって誤ってエラー扱いされない
  -- ようにするため。この行内の値照合だけで完結するため accepted_request_id に
  -- UNIQUE制約は付けない。
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

  -- 3. 検証。ここから先の失敗はすべて「業務上あり得る通常フロー」であり、
  -- RAISE EXCEPTIONではなくエラーコード入りJSONBを返す。理由: カード定義削除・
  -- 出品カード喪失の2パスは、検証失敗時に trade_offers を cancelled へ更新した
  -- 上でエラーを返す必要があるが、RAISE EXCEPTIONは呼び出し元のtransactionを
  -- 巻き戻すため、その cancelled 更新自体がロールバックされてしまう
  -- (00060はDELETE同士で相殺できたが、本RPCはUPDATEでの状態遷移を保持したい
  -- ため方式が異なる)。他の検証も含め方式を統一し、呼び出し側は常に
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

  -- 応諾者の支払いカード選択(ロック順3番目: 応諾者のuser_cards行)。2段構成:
  --   (1) 候補コピーをLIMITなしで全ロック
  --   (2) ロック確定後にORDER BY obtained_at ASC LIMIT 1で最古の1枚を選定
  -- 「ORDER BY ... LIMIT 1 ... FOR UPDATE」の単一クエリだと、ロック待ち中に
  -- 対象行が条件を外れた(他transactionが移転させた)場合に次点へ繰り上がらず、
  -- 使用可能なコピーが残っているのに誤ってCARD_NOT_OWNEDを返しうる(00059/00060
  -- と同じ理由)。自分がopenオファーとして出品中のコピーは、成立すれば
  -- 二重譲渡になるため候補から除外する。
  PERFORM 1
  FROM user_cards
  WHERE user_id = v_user_id
    AND card_id = v_offer.wanted_card_id
    AND id NOT IN (
      SELECT offered_user_card_id FROM public.trade_offers
      WHERE offerer_user_id = v_user_id AND status = 'open'
    )
  FOR UPDATE;

  -- この2段目のSELECTは意図的に FOR UPDATE を付けない(付けると240-244で避けた
  -- 「LIMIT 1 + FOR UPDATE が繰り上がらない」問題を再導入する)。245-253の
  -- PERFORM(LIMITなし・応諾者が保有する候補行を全ロック)は、事前に存在する
  -- 候補行を巡る単純な2並行accept_trade_offer同士は正しく直列化する
  -- (先着1件がロックを取り、後着はブロック後EvalPlanQualで対象から外れるか
  -- 別候補へ繰り上がる。2接続同時実行での実測でも確認済み)。それでも
  -- READ COMMITTED ではこのPERFORMとこのSELECTの間(スナップショットAと
  -- スナップショットBの間)に、応諾者が同じwanted_card_idの新規コピーを
  -- 第三のトランザクション(ガチャ・別トレード成立等、この応諾処理と無関係な
  -- 経路)で取得してcommitする余地が理論上残り、そのコピーは253までの
  -- PERFORMには含まれない(存在しなかったため)。この行を「選定候補」に
  -- 過ぎないものとして扱い、実際の所有権移転(下記UPDATE)を
  -- user_id条件付き・行数チェック付きにすることで最終防御する
  -- (Claude Auto Reviewレビュー指摘: PRレビューで検出)。
  SELECT id INTO v_payer_user_card_id
  FROM user_cards
  WHERE user_id = v_user_id
    AND card_id = v_offer.wanted_card_id
    AND id NOT IN (
      SELECT offered_user_card_id FROM public.trade_offers
      WHERE offerer_user_id = v_user_id AND status = 'open'
    )
  ORDER BY obtained_at ASC, id ASC
  LIMIT 1;

  IF v_payer_user_card_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_OWNED');
  END IF;

  -- 4. 所有権移転(row-per-copyなのでUPDATEでuser_idを付け替える。新規発行では
  -- ないためmax_issuance_countには影響せず、card_owner_statsトリガー(00051)は
  -- OLD/NEW双方を再集計するためuser_id付け替えと整合する)
  --
  -- 支払いカード側を先に更新する(出品カード側より先)。支払いカード候補は
  -- 267-276で意図的にロックなしSELECTのため、`AND user_id = v_user_id` を
  -- 付けた条件付きUPDATE + GET DIAGNOSTICS の行数チェックで最終防御する
  -- (Claude Auto Reviewレビュー指摘: PRレビューで検出)。
  --
  -- 到達条件についての注記: 245-253のPERFORM(LIMITなし・候補行を全ロック)が
  -- 既に大半のケースを直列化するため、単純に「同一応諾者が同じカード種別を
  -- 要求する2件のオファーを並行accept」しただけでは、事前に存在する候補行を
  -- 巡る競合はPERFORMの時点でブロック→EvalPlanQualにより解消され、この
  -- 行数チェックには到達しない(2接続同時実行での実測で確認済み。
  -- tests/fixtures/add-card-trading-concurrency.sh 参照)。この行数チェックが
  -- 実際に0件を検出しうるのは、応諾者自身のPERFORM実行後・このSELECT実行前の
  -- 間に、この応諾処理と無関係な第三のトランザクション(ガチャ・別トレード
  -- 成立等)が新規コピーをcommitし、かつそのコピーを複数の並行acceptが
  -- ロックなしSELECTで同一に選定してしまう、という極めて狭いタイミングの
  -- 場合に限られる。この狭い窓を2接続の黒箱テストで決定的に再現することは
  -- 実務上困難だったため、直接の再現テストは無い。それでも
  -- 「stage 2のSELECTはロックを持たない」という事実自体は変わらないため、
  -- コストがほぼ0のこのfail-closedガードは保持する(00059/00060と同じ
  -- 「選定はロックなしでも、移転はロック相当の確認をしてから行う」防御的
  -- 多重化の考え方)。
  --
  -- 0件なら「選定後に何らかの経路で対象コピーの所有権が変わった」ことを
  -- 意味する。ここではまだ出品カード側(offered_user_card_id)もオファー行の
  -- statusも更新していないため、この時点でJSONBをRETURNしても部分的な
  -- 副作用は残らず(RAISE EXCEPTIONによるロールバックを使わずに)安全に
  -- CARD_NOT_OWNEDへfail-closedできる。出品カード側(226-230で既に
  -- FOR UPDATE済みの行)は対称に条件を付けなくても安全なため、無条件
  -- UPDATEのままでよい。
  UPDATE user_cards SET user_id = v_offer.offerer_user_id, obtained_at = now()
    WHERE id = v_payer_user_card_id AND user_id = v_user_id;
  GET DIAGNOSTICS v_payer_update_count = ROW_COUNT;

  IF v_payer_update_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_OWNED');
  END IF;

  UPDATE user_cards SET user_id = v_user_id, obtained_at = now()
    WHERE id = v_offer.offered_user_card_id;

  -- 5. オファーをcompletedに更新
  UPDATE public.trade_offers SET
    status = 'completed',
    accepted_by_user_id = v_user_id,
    accepted_user_card_id = v_payer_user_card_id,
    accepted_request_id = p_request_id,
    completed_at = now()
  WHERE id = p_trade_offer_id;

  RETURN jsonb_build_object(
    'success', true,
    'tradeOfferId', v_offer.id,
    'receivedUserCardId', v_offer.offered_user_card_id,
    'givenUserCardId', v_payer_user_card_id,
    'offeredCardSnapshot', v_offer.offered_card_snapshot,
    'wantedCardSnapshot', v_offer.wanted_card_snapshot,
    'completedAt', now(),
    'idempotentReplay', false
  );
END;
$$;

COMMENT ON TABLE public.trade_offers IS
  'カードトレードのオープンオファー(掲示板方式)。completed行がそのままトレード履歴になる(別テーブルは作らない、YAGNI)。';

COMMENT ON FUNCTION public.accept_trade_offer(text, uuid, uuid) IS
  'トレードオファーの応諾。FOR UPDATE 2段ロック+エラーコードJSONB返却でOFFER_INVALID系のcancelled更新をコミット可能にする。詳細はtasks/plans/issue-715-card-trading.md §4.4。';

-- ============================================================
-- 4. アクセス制御(db/planetscale/grants.sqlのALTER DEFAULT PRIVILEGESで
-- 自動付与されるが、20260725100000と同じく明示しておく防御的多重化)
-- ============================================================
REVOKE ALL ON TABLE public.trade_offers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_offers TO service_role;

REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid) TO service_role;
