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
--   - 応諾は「利用者が同意した枚数」を照合する compare-and-set にする。
--     4引数の accept_trade_offer(text, uuid, uuid, smallint) を新設し、
--     p_expected_quantity がオファーの wanted_quantity と一致する場合だけ、
--     応諾者のコピーを wanted_quantity 枚まとめて移転する。
--   - 既存の3引数版は「期待枚数1」で4引数版を呼ぶ互換ラッパーへ置き換える。
--     旧アプリ(デプロイ前から開いているタブ・アプリのロールバック後)は ×N を
--     知らずに「1枚」と表示して応諾を送るため、×N のオファーを3引数版で
--     成立させると、利用者が同意していない枚数を失う。3引数版は ×N を
--     移転せず、旧アプリが既に知っている OFFER_NOT_OPEN で fail-closed する。
--   - 返却JSONの既存キーはすべて維持する(givenUserCardId は移転したうちの最古の1枚)。
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

-- 20260817100000_add_card_trading.sql の accept_trade_offer を N 枚対応にした4引数版。
-- 変更点は「3. 応諾者の支払いカード選択」と「4. 所有権移転」だけで、
-- ロック順(オファー行 → 出品者の user_cards 行 → 応諾者の支払い user_cards 行)・
-- 冪等リプレイ・エラーコード JSONB 方式・設定ゲートは元の実装と同一。
-- 各判断の詳しい理由は元 migration のコメントを参照。
CREATE FUNCTION public.accept_trade_offer(
  p_twitch_user_id text,
  p_trade_offer_id uuid,
  p_request_id uuid,
  p_expected_quantity smallint
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
  IF p_twitch_user_id IS NULL OR p_trade_offer_id IS NULL OR p_request_id IS NULL
     OR p_expected_quantity IS NULL THEN
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

  -- 同意した枚数の照合(compare-and-set)。冪等リプレイ判定の後に置くのは、
  -- 成立済みの再送を枚数に関係なく成功扱いにするため(リプレイは同じ
  -- requestId = 同じ同意の再送)。どの書き込みよりも前なので副作用は無い。
  IF v_offer.wanted_quantity <> p_expected_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'QUANTITY_MISMATCH');
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
  -- 書き込まないうちに CARD_NOT_OWNED を返す。(1) の時点で存在した行は
  -- (1) で既にロック済みなので、(3) の ORDER BY id が実際に順序を決めるのは
  -- (1) より後に現れた行だけ(その行どうしのロック順を並行応諾間で揃える)。
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

COMMENT ON FUNCTION public.accept_trade_offer(text, uuid, uuid, smallint) IS
  'トレードオファーの応諾(#1789)。p_expected_quantity がオファーの wanted_quantity と一致する場合だけ、応諾者の wanted_card_id コピーを wanted_quantity 枚まとめて移転する(不一致は QUANTITY_MISMATCH)。FOR UPDATE ロック+エラーコードJSONB返却でOFFER_INVALID系のcancelled更新をコミット可能にする。詳細はtasks/plans/issue-715-card-trading.md §4.4。';

-- 旧アプリ向けの3引数版。期待枚数1で4引数版を呼び、×N のオファーは移転せず
-- 旧アプリが既知の OFFER_NOT_OPEN で拒否する(QUANTITY_MISMATCH は旧アプリの
-- 結果検証が知らないコードで、500 になるため読み替える)。成立済みの冪等リプレイは
-- 4引数版が枚数照合より前に返すので、旧アプリからの再送も従来どおり成功する。
CREATE OR REPLACE FUNCTION public.accept_trade_offer(
  p_twitch_user_id text,
  p_trade_offer_id uuid,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.accept_trade_offer(p_twitch_user_id, p_trade_offer_id, p_request_id, 1::smallint);
  IF v_result->>'error' = 'QUANTITY_MISMATCH' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_OPEN');
  END IF;
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.accept_trade_offer(text, uuid, uuid) IS
  '旧アプリ互換の応諾(期待枚数1)。×N のオファーは OFFER_NOT_OPEN で拒否し、移転しない(#1789)。';

REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid, smallint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid, smallint) TO service_role;
-- CREATE OR REPLACE は既存の権限を保持するが、元 migration と同じく明示しておく。
REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid) TO service_role;
