-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1790 (#715 / 問い合わせ #1788 要望②③): 「求に指定できるカード」の制限。
-- 仕様は Issue #1790 の 2026-10-14「仕様確定」コメントが正本。
--
--   - cards.trade_wantable を追加する(既定 true = 指定可)。配信者はカード管理画面で
--     自分のカードを「求に指定できない」に切り替えられる(例: コインカードだけを
--     指定可にして通貨として使う)。「渡す」側は制限しない。
--   - 出品(POST /api/trades)・求めるカードの選択肢・ボード・マイトレードの判定は
--     アプリ側(src/lib/trade.ts)、応諾の最終判定はこの migration の
--     accept_trade_offer が行う。
--   - 既存の open オファーで求めるカードが指定不可になったものは cancelled にせず
--     残す(ボード非表示・応諾不可・出品者のマイトレードで「応じられない出品」)。
--     設定を戻せばそのまま復活する。
--
-- 方針(expand のみ・加法的変更):
--   - NOT NULL DEFAULT true(定数既定値)の列追加は PostgreSQL 11 以降テーブル
--     書き換えを伴わない。既存カード・旧アプリが作るカードはすべて従来どおり指定可。
--   - アプリの Drizzle 定義では、この列を cards 本体ではなく専用の狭い定義
--     (src/lib/db/schema.ts の cardTradeSettings)に置く。cards 本体は
--     ガチャ・図鑑・カード管理などで無指定 select / insert されており、列を
--     足すと migration 未適用のデプロイ窓でそれらが全て 42703 になるため。
--     トレード側の参照は src/lib/trade.ts で列欠落時に「全カード指定可」
--     (= 列の既定値で、migration 前は実際に全カードが指定可)へ縮退する。
--   - accept_trade_offer の4引数版を CREATE OR REPLACE で差し替え、求めるカードの
--     指定可否を確認する。差分は下の「#1790」コメントの1ブロックだけで、ロック順・
--     冪等リプレイ(検証より前)・エラーコード JSONB 方式・枚数照合・設定ゲートは
--     20261011120000_trade_wanted_quantity.sql と同一。各判断の詳しい理由は
--     20260817100000_add_card_trading.sql / 20261011120000 のコメントを参照。
--   - 3引数版(旧アプリ互換ラッパー)も差し替え、新コードを旧アプリが既知の
--     OFFER_NOT_OPEN へ読み替える(QUANTITY_MISMATCH と同じ扱い)。

ALTER TABLE public.cards
  ADD COLUMN trade_wantable boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.cards.trade_wantable IS
  'トレードの「求めるカード」に指定できるか(#1790)。false にできるのはカードの配信者のみ(カード管理画面)。false のカードは新規出品の求めるカードに選べず、既存の open オファーもボード非表示・応諾不可(accept_trade_offer が WANTED_CARD_NOT_WANTABLE)になる。true に戻せば復活する。渡す側は制限しない。';

-- 20261011120000_trade_wanted_quantity.sql の4引数版に、求めるカードの指定可否の
-- 確認(#1790 ブロック)だけを加えたもの。それ以外は1文字も変えていない。
CREATE OR REPLACE FUNCTION public.accept_trade_offer(
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
  v_wanted_card_wantable boolean;
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

  -- #1790: 求めるカードが「求に指定できる」(cards.trade_wantable)ままかを確認する。
  -- 出品後に配信者が指定不可へ切り替えたオファーは、ボードで非表示にするだけでなく
  -- ここでも拒否する(API 直叩き・ボード取得後の切替・API 層の事前チェックを
  -- 持たない旧アプリでも成立させないため)。
  --   * 位置: 冪等リプレイ判定(2)と枚数照合の後、どの行ロック・書き込みよりも前。
  --     成立済みの再送は従来どおり成功扱いになり、拒否時に副作用は無い。
  --   * cancelled へは更新しない(OFFER_INVALID と違い、配信者が設定を戻せば
  --     同じオファーがそのまま応諾可能に戻る仕様のため)。
  --   * cards 行はロックしない。trade_enabled 等の設定ゲートと同じく、切替と
  --     並行した応諾は「切替の直前に成立した」のと区別できず、既存2コピーの
  --     交換しか起きないため許容する。ロック順(オファー → 出品者 user_cards →
  --     応諾者 user_cards)にも新しい行を加えない。
  --   * 行が無い/NULL は IS NOT TRUE で拒否(fail-closed)。wanted_card_id が
  --     NULL のケースは上の OFFER_INVALID で既に返っている。
  --   * エラーコードは新設の WANTED_CARD_NOT_WANTABLE。#1790 以前のアプリは
  --     このコードを知らず、結果検証(isValidTradeAcceptRpcResult)が例外にして
  --     500 を返す = 何も移転しない fail-closed になる。なお旧アプリには
  --     trade_wantable を false にする経路が無いため、この分岐に旧アプリが
  --     到達するのはアプリをロールバックした場合だけである。
  SELECT trade_wantable INTO v_wanted_card_wantable
  FROM public.cards
  WHERE id = v_offer.wanted_card_id;

  IF v_wanted_card_wantable IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', 'WANTED_CARD_NOT_WANTABLE');
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
  -- 部分移転がコミットされてしまう。(1) のロック対象外だった行(第三の
  -- トランザクションが commit した新規コピー、(1) の直後に出品が取り下げられた
  -- コピー等)も (2) で選ばれうるため、(3) で選定行すべてをロックしてから
  -- 数え直し、N 枚そろわなければ何も書き込まないうちに CARD_NOT_OWNED を返す。
  -- (3) の ORDER BY id は、そうした (1) のロック対象外だった行どうしの順序を
  -- 揃えるだけで、並行応諾の (1) の走査順とは一致しない。理論上残る 40P01 は
  -- アプリ側の1回再試行(src/lib/trade.ts acceptTradeOffer)に任せる。
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
  'トレードオファーの応諾(#1789/#1790)。p_expected_quantity がオファーの wanted_quantity と一致し(不一致は QUANTITY_MISMATCH)、求めるカードの cards.trade_wantable が true の場合(false は WANTED_CARD_NOT_WANTABLE、オファーは open のまま)だけ、応諾者の wanted_card_id コピーを wanted_quantity 枚まとめて移転する。FOR UPDATE ロック+エラーコードJSONB返却でOFFER_INVALID系のcancelled更新をコミット可能にする。詳細はtasks/plans/issue-715-card-trading.md §4.4。';

-- 旧アプリ向けの3引数版。4引数版が返す新しいコード(QUANTITY_MISMATCH /
-- WANTED_CARD_NOT_WANTABLE)は旧アプリの結果検証が知らず 500 になるため、
-- 旧アプリが既知の OFFER_NOT_OPEN へ読み替える。どちらも何も移転していない。
-- 成立済みの冪等リプレイは4引数版が検証より前に返すので従来どおり成功する。
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
  IF v_result->>'error' IN ('QUANTITY_MISMATCH', 'WANTED_CARD_NOT_WANTABLE') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_OPEN');
  END IF;
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.accept_trade_offer(text, uuid, uuid) IS
  '旧アプリ互換の応諾(期待枚数1)。×N のオファーと、求めるカードが指定不可になったオファーは OFFER_NOT_OPEN で拒否し、移転しない(#1789/#1790)。';

-- CREATE OR REPLACE は既存の権限を保持するが、既存 migration と同じく明示しておく。
REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid, smallint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid, smallint) TO service_role;
REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid) TO service_role;
