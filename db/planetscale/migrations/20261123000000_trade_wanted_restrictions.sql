-- migration-transaction: required
-- migration-providers: planetscale

-- トレードの「交換対象の制限」(出品カードごとのホワイトリスト)。
-- 設計は tasks/plans/trade-wanted-restriction.md(§4 が本 migration に対応する)。
--
--   - 配信者は、自分の出品カード A ごとに「求めるカード(オークションでは入札カード)に
--     指定できるカード」の集合 W(A) を設定できる。A にルールが無ければ制限なし。
--     ルールがあれば W(A) 内のカードだけが指定できる。
--   - 既存の cards.trade_wantable(#1790: どの出品からも求められないカード)とは直交する
--     制約で、判定は両方の AND。
--
-- 方針(expand のみ・加法的変更):
--   - 新規テーブル2つ(ルール = 親 / 許可カード = 子)の追加と、既存関数の
--     CREATE OR REPLACE だけ。既存テーブルへの変更・既存データの更新・削除は無い
--     (適用直後はルールが空 = 全カード制限なしで、既存の出品・入札・応諾の結果は変わらない。
--     tests/unit/trade-wanted-restriction-migration.test.ts で固定する)。
--   - 親子2テーブルにする理由: (1) 子が0件でも「ルールあり = 誰も指定できない」を表せる。
--     カードは物理削除される(DELETE /api/cards/[id])ので、許可カードを全部削除したときに
--     ルールごと消えて制限が外れる(fail-open)のを避ける。(2) 親行が設定更新の直列化
--     ロック行になる(アプリの PUT は親行を ON CONFLICT DO UPDATE で取ってから子を置換する)。
--   - 差し替える関数は、それぞれ最新定義から「制限の確認ブロック」だけを足したもの
--     (差分は tests/unit/trade-wanted-restriction-migration.test.ts で固定する):
--       accept_trade_offer(4引数)  : 20261018030000_trade_auctions.sql
--       accept_trade_offer(3引数)  : 20261014100000_card_trade_wantable.sql
--       place_trade_auction_bid    : 20261018030000_trade_auctions.sql
--       trade_auction_bid_unsettleable_reason : 20261018030000_trade_auctions.sql
--     settle_trade_auction は後者を呼ぶだけなので差し替えない。
--
-- migration 未適用の窓(アプリと migration の適用は非同期。docs/db-driver-migration.md):
--   migration を先に適用しても旧アプリは新テーブルを参照せず、ルールが空なら新ブロックは
--   通過するので安全(適用の正本は DB 先行。docs/QA.md「migrationとアプリの適用順序」)。
--   アプリ側にはデプロイ窓のフォールバックを入れない。アプリが先に出た場合は、新テーブルが
--   無い間(42P01)の出品・ボード・応諾の事前チェックが一時的にエラーになり、migration の
--   適用後に自然復旧する(読み書きとも誤った結果を返すことは無い)。

SET LOCAL lock_timeout = '5s';

-- ============================================================
-- 1. trade_wanted_restriction_rules(ルール = 出品カードごとに1行)
-- ============================================================
CREATE TABLE public.trade_wanted_restriction_rules (
  offered_card_id uuid PRIMARY KEY REFERENCES public.cards(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.trade_wanted_restriction_rules IS
  'トレードの「交換対象の制限」のルール。行がある出品カードは、求めるカード(オークションでは入札カード)が trade_wanted_restriction_items の許可に入っているものに限られる。行が無ければ制限なし。許可0件でもルールは残り、その場合は誰も指定できない(fail-closed)。';

-- ============================================================
-- 2. trade_wanted_restriction_items(許可カード)
-- ============================================================
CREATE TABLE public.trade_wanted_restriction_items (
  offered_card_id uuid NOT NULL
    REFERENCES public.trade_wanted_restriction_rules(offered_card_id) ON DELETE CASCADE,
  wanted_card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (offered_card_id, wanted_card_id),
  CONSTRAINT trade_wanted_restriction_items_different_cards
    CHECK (offered_card_id <> wanted_card_id)
);

-- 許可カード(wanted_card_id)が削除されたときの ON DELETE CASCADE が全件走査にならないための
-- 逆引き索引。判定側は主キー(offered_card_id, wanted_card_id)で引ける。
CREATE INDEX idx_trade_wanted_restriction_items_wanted
  ON public.trade_wanted_restriction_items (wanted_card_id);

COMMENT ON TABLE public.trade_wanted_restriction_items IS
  'トレードの「交換対象の制限」の許可カード。同一配信者のカードであることは書き込み API が検証する(判定は集合所属だけを見る)。';

-- ============================================================
-- 3. accept_trade_offer(4引数版)の置き換え
-- ============================================================
-- 20261018030000_trade_auctions.sql の4引数版に、制限の確認(制限ブロック)だけを
-- 加えたもの。返却 JSON・既存のエラーコード・ロック順・冪等リプレイは不変。
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

  -- 出品カードの配信者が設定した「交換対象の制限」(ホワイトリスト)の確認。
  -- 出品カード(offered_card_id)にルール(trade_wanted_restriction_rules の行)があり、
  -- 求めるカードがその許可集合(trade_wanted_restriction_items)に無いオファーは、
  -- ボードで非表示にするだけでなくここでも拒否する(API 直叩き・ボード取得後の設定変更・
  -- 事前チェックを持たない旧アプリでも成立させないため)。
  --   * 位置と性質は直前の #1790 ブロックと同じ: 冪等リプレイ判定(2)と枚数照合の後、
  --     どの行ロック・書き込みよりも前。成立済みの再送は従来どおり成功扱いで、拒否時に
  --     副作用は無い。cancelled へは更新しない(配信者がルールを戻せば同じオファーが
  --     そのまま応諾可能に戻る)。
  --   * ルール行・許可行はロックしない(設定の切替と並行した応諾は「切替の直前に成立した」
  --     のと区別できない)。ロック順(オファー → 出品者 user_cards → 応諾者 user_cards)にも
  --     新しい行を加えない。
  --   * 「ルールあり」と「許可に入っていない」を1つの IF 式に書く(判定を1つの
  --     スナップショットで行い、2文に分けて間に設定が変わる隙間を作らない)。
  --   * ルールがあって許可0件(許可カードが全て削除された)は誰も指定できない状態で、
  --     制限は外れない(fail-closed)。ルールが無ければこのブロックは通過する。
  --   * エラーコードは新設の WANTED_CARD_NOT_ALLOWED_FOR_OFFERED。旧アプリはこのコードを
  --     知らず、結果検証が例外にして 500 を返す = 何も移転しない fail-closed になる
  --     (旧アプリにはルールを作る経路が無く、到達するのはアプリのロールバック時だけ)。
  IF EXISTS (SELECT 1 FROM public.trade_wanted_restriction_rules
             WHERE offered_card_id = v_offer.offered_card_id)
     AND NOT EXISTS (SELECT 1 FROM public.trade_wanted_restriction_items
                     WHERE offered_card_id = v_offer.offered_card_id
                       AND wanted_card_id = v_offer.wanted_card_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED');
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
  -- #1791: 除外条件を trade_copy_locked(id) に広げ、オークションの出品・有効な
  -- 入札で拘束中のコピーも支払いに使わない(拘束の判定はこの1関数に一元化する)。
  PERFORM 1
  FROM user_cards
  WHERE user_id = v_user_id
    AND card_id = v_offer.wanted_card_id
    AND NOT public.trade_copy_locked(id)
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
      AND NOT public.trade_copy_locked(id)
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

  -- #1791: 数え直しにも拘束判定を加える。(2) の選定から (3) のロック取得までの
  -- 間に、並行する入札(place_trade_auction_bid)が同じコピーを拘束して commit
  -- しうるため。この文は (3) のロック取得後の新しいスナップショットで評価される
  -- ので、その commit が見え、拘束されたコピーは数から外れて CARD_NOT_OWNED になる。
  SELECT count(*) INTO v_payer_locked_count
  FROM user_cards
  WHERE id = ANY (v_payer_user_card_ids)
    AND user_id = v_user_id
    AND NOT public.trade_copy_locked(id);

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
  'トレードオファーの応諾(#1789/#1790/#1791)。p_expected_quantity がオファーの wanted_quantity と一致し(不一致は QUANTITY_MISMATCH)、求めるカードの cards.trade_wantable が true(false は WANTED_CARD_NOT_WANTABLE)で、かつ出品カードに交換対象の制限があるときは求めるカードがその許可に入っている(入っていなければ WANTED_CARD_NOT_ALLOWED_FOR_OFFERED。どちらもオファーは open のまま)場合だけ、応諾者の wanted_card_id コピーのうち拘束されていないもの(trade_copy_locked = false: 通常出品・オークション出品・有効な入札のいずれにも使われていない)を wanted_quantity 枚まとめて移転する。FOR UPDATE ロック+エラーコードJSONB返却でOFFER_INVALID系のcancelled更新をコミット可能にする。詳細はtasks/plans/issue-715-card-trading.md §4.4、tasks/plans/issue-1791-trade-auction.md §4.1、tasks/plans/trade-wanted-restriction.md。';

-- ============================================================
-- 4. accept_trade_offer(3引数版 = 旧アプリ互換ラッパー)の置き換え
-- ============================================================
-- 4引数版が返す新しいコードは旧アプリの結果検証が知らず 500 になるため、旧アプリが
-- 既知の OFFER_NOT_OPEN へ読み替える(どちらも何も移転していない)。
-- 土台は 20261014100000_card_trade_wantable.sql の3引数版(オークション migration は
-- 置き換えていない)。
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
  IF v_result->>'error' IN (
    'QUANTITY_MISMATCH', 'WANTED_CARD_NOT_WANTABLE', 'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_OPEN');
  END IF;
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.accept_trade_offer(text, uuid, uuid) IS
  '旧アプリ互換の応諾(期待枚数1)。×N のオファー、求めるカードが指定不可になったオファー、求めるカードが交換対象の制限に入っていないオファーは OFFER_NOT_OPEN で拒否し、移転しない(#1789/#1790)。';

-- ============================================================
-- 5. オークション: 入札の可否と成立可否
-- ============================================================
-- 20261018030000_trade_auctions.sql の各関数に制限の確認(制限ブロック)だけを加えたもの。
CREATE OR REPLACE FUNCTION public.place_trade_auction_bid(
  p_twitch_user_id text,
  p_auction_id uuid,
  p_bid_card_id uuid,
  p_quantity smallint,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id uuid;
  v_auction public.trade_auctions%ROWTYPE;
  v_bid public.trade_auction_bids%ROWTYPE;
  v_previous_bid_id uuid;
  v_card public.cards%ROWTYPE;
  v_offered_active boolean;
  v_offered_trade boolean;
  v_offered_cross boolean;
  v_bid_trade boolean;
  v_bid_cross boolean;
  v_is_cross boolean;
  v_active_bids integer;
  v_copy_ids uuid[];
  v_locked_count integer;
BEGIN
  IF p_twitch_user_id IS NULL OR p_auction_id IS NULL OR p_bid_card_id IS NULL
     OR p_quantity IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT id INTO v_user_id FROM public.users WHERE twitch_user_id = p_twitch_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  END IF;

  -- 1. オークション行をロック(ロック順の起点。同じオークションへの入札・取り下げ・
  --    取消・成立はすべてここで直列化される)
  SELECT * INTO v_auction FROM public.trade_auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_FOUND');
  END IF;

  -- 2. 冪等リプレイ(すべての検証より前)。同じ requestId が別のオークションに使われて
  --    いたら要求の誤りとして拒否する(他人の入札を返さない。requestId は入札者単位で一意)。
  SELECT * INTO v_bid FROM public.trade_auction_bids
  WHERE bidder_user_id = v_user_id AND request_id = p_request_id;
  IF FOUND THEN
    IF v_bid.auction_id <> p_auction_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'REQUEST_ID_CONFLICT');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'bid', to_jsonb(v_bid), 'replacedBidId', NULL, 'idempotentReplay', true
    );
  END IF;

  IF p_quantity < 1 OR p_quantity > 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_QUANTITY');
  END IF;

  -- 3. 受付中か。時刻はロック取得後に clock_timestamp() で判定する(計画レビュー M3)。
  IF v_auction.status <> 'open' OR clock_timestamp() >= v_auction.ends_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_OPEN');
  END IF;

  IF v_auction.seller_user_id = v_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'SELF_BID_FORBIDDEN');
  END IF;

  -- 出品カードが削除・無効化されたオークションには入札させない(ボードにも出ない)。
  SELECT is_active INTO v_offered_active FROM public.cards WHERE id = v_auction.offered_card_id;
  IF v_auction.offered_card_id IS NULL OR v_offered_active IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_FOUND');
  END IF;

  -- 出品カードと同じ種別では入札できない(trade_offers_different_cards と揃える)。
  IF p_bid_card_id = v_auction.offered_card_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'SAME_CARD');
  END IF;

  SELECT * INTO v_card FROM public.cards WHERE id = p_bid_card_id;
  IF NOT FOUND OR v_card.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', 'BID_CARD_UNAVAILABLE');
  END IF;

  -- 4. 設定ゲート。入札カードの配信者がオークションの配信者と異なればクロスチャンネル
  --    扱いで、両配信者の trade_enabled と cross_channel_trade_enabled を要求する。
  v_is_cross := v_card.streamer_id <> v_auction.offered_streamer_id;
  SELECT trade_enabled, cross_channel_trade_enabled INTO v_offered_trade, v_offered_cross
    FROM public.streamers WHERE id = v_auction.offered_streamer_id;
  SELECT trade_enabled, cross_channel_trade_enabled INTO v_bid_trade, v_bid_cross
    FROM public.streamers WHERE id = v_card.streamer_id;
  IF NOT COALESCE(v_offered_trade, false) OR NOT COALESCE(v_bid_trade, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRADE_DISABLED');
  END IF;
  IF v_is_cross AND (NOT COALESCE(v_offered_cross, false) OR NOT COALESCE(v_bid_cross, false)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRADE_DISABLED');
  END IF;

  -- 入札カードは「求に指定できる」カードに限る(#1790 の制限を適用。オーナー確定)。
  IF v_card.trade_wantable IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', 'BID_CARD_NOT_WANTABLE');
  END IF;

  -- 出品カードの配信者が設定した「交換対象の制限」。出品カード(オークションの
  -- offered_card_id)にルールがあれば、入札カードはその許可集合に入っているものに限る
  -- (通常出品の accept_trade_offer と同じ判定。ルールが無ければ通過し、許可0件のルールは
  -- 誰も入札できない = fail-closed)。冪等リプレイ判定はこれより前にあるので、成立済みの
  -- 入札の再送は影響を受けない。1つの IF 式 = 1つのスナップショット。
  IF EXISTS (SELECT 1 FROM public.trade_wanted_restriction_rules
             WHERE offered_card_id = v_auction.offered_card_id)
     AND NOT EXISTS (SELECT 1 FROM public.trade_wanted_restriction_items
                     WHERE offered_card_id = v_auction.offered_card_id
                       AND wanted_card_id = v_card.id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'BID_CARD_NOT_ALLOWED_FOR_OFFERED');
  END IF;

  -- 5. 既存の自分の有効入札(このオークション)。変更の場合は置き換える。
  SELECT id INTO v_previous_bid_id FROM public.trade_auction_bids
  WHERE auction_id = p_auction_id AND bidder_user_id = v_user_id AND status = 'active'
  FOR UPDATE;

  -- 有効入札の上限(1人10件。拘束中のオークションへの active だけを数える)。
  -- 変更はこのオークションの入札を置き換えるだけなので数えない。
  SELECT count(*) INTO v_active_bids
  FROM public.trade_auction_bids b
  WHERE b.bidder_user_id = v_user_id AND b.status = 'active'
    AND b.auction_id <> p_auction_id
    AND public.trade_auction_holds_cards(b.auction_id);
  IF v_active_bids >= 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'BID_LIMIT');
  END IF;

  -- 6. 入札コピーの選定。accept_trade_offer と同じ3段構成(各段の理由はその注記を参照):
  --   (1) 入札者の bid_card_id のコピーを LIMIT なしで id 昇順に全ロック
  --   (2) ロック後の新しい文で、拘束されていないものから最古の N 件を選ぶ
  --   (3) 選定行を改めてロックし、所有と拘束を数え直す
  -- 置き換え前の自分の入札(v_previous_bid_id)が拘束しているコピーは、この入札で
  -- 再利用できるものとして扱う(書き込みは検証がすべて通ってからにするため、まだ
  -- withdrawn にしていない)。失敗時に JSONB を返しても旧入札は変わらない。
  --
  -- (1) のロック対象には出品コピー(offered_user_card_id)も含め、全体を id 昇順で取る
  -- (PR #1850 独立レビュー必須 M1(a))。入札0件のオークションは締切の瞬間に出品コピーを
  -- 解放する(trade_auction_holds_cards)。出品コピーをロックしないと、締切直前に始まった
  -- この入札が締切後に commit するまでの間に、出品者が同じコピーを通常出品でき
  -- (トリガーは「入札0件で締切済み = 拘束なし」と判定する)、open な通常出品と選択待ちの
  -- オークションが同じコピーを二重に拘束してしまう。出品コピーの行をこの入札が持てば、
  -- トリガー(同じ行を FOR UPDATE する)はこの commit を待ってから判定し、選択待ちの
  -- 拘束を見て拒否する。逆に通常出品が先にロックを取って締切後に commit した場合は、
  -- 下の再判定でこの入札が AUCTION_NOT_OPEN になる。
  -- (tests/fixtures/trade-auction-concurrency.sh S7)
  PERFORM 1
  FROM public.user_cards
  WHERE (user_id = v_user_id AND card_id = p_bid_card_id)
     OR id = v_auction.offered_user_card_id
  ORDER BY id
  FOR UPDATE;

  -- ロック待ちの間に締切を越えうるので、ロック取得後の clock_timestamp() で受付中かを
  -- 再判定する(上の 3. はオークション行のロック直後の判定で、この行ロックの待ちを含まない)。
  IF clock_timestamp() >= v_auction.ends_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_OPEN');
  END IF;

  -- 出品者がまだ出品コピーを所有し、そのコピーが通常出品に使われていないこと
  -- (ロック後の行で確認する。レビュー任意5)。所有が変わっていれば、このオークションは
  -- 成立できないので入札を受け付けない。通常出品との二重拘束はトリガーと上の再判定で
  -- 起きないが、起きていれば入札で拘束を重ねないよう拒否する(防御)。
  IF NOT EXISTS (
    SELECT 1 FROM public.user_cards
    WHERE id = v_auction.offered_user_card_id AND user_id = v_auction.seller_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.trade_offers
    WHERE offered_user_card_id = v_auction.offered_user_card_id AND status = 'open'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_OPEN');
  END IF;

  SELECT array_agg(candidate.id ORDER BY candidate.obtained_at ASC, candidate.id ASC)
    INTO v_copy_ids
  FROM (
    SELECT uc.id, uc.obtained_at
    FROM public.user_cards uc
    WHERE uc.user_id = v_user_id
      AND uc.card_id = p_bid_card_id
      AND (
        NOT public.trade_copy_locked(uc.id)
        OR EXISTS (
          SELECT 1 FROM public.trade_auction_bid_items own_item
          WHERE own_item.bid_id = v_previous_bid_id AND own_item.user_card_id = uc.id
        )
      )
    ORDER BY uc.obtained_at ASC, uc.id ASC
    LIMIT p_quantity
  ) AS candidate;

  IF COALESCE(array_length(v_copy_ids, 1), 0) < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_ENOUGH_CARDS');
  END IF;

  PERFORM 1 FROM public.user_cards WHERE id = ANY (v_copy_ids) ORDER BY id FOR UPDATE;

  SELECT count(*) INTO v_locked_count
  FROM public.user_cards uc
  WHERE uc.id = ANY (v_copy_ids)
    AND uc.user_id = v_user_id
    AND (
      NOT public.trade_copy_locked(uc.id)
      OR EXISTS (
        SELECT 1 FROM public.trade_auction_bid_items own_item
        WHERE own_item.bid_id = v_previous_bid_id AND own_item.user_card_id = uc.id
      )
    );
  IF v_locked_count <> p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_ENOUGH_CARDS');
  END IF;

  -- 7. 書き込み(ここから先は失敗しない)。旧入札を withdrawn にしてから新入札を作る
  --    (部分UNIQUE idx_trade_auction_bids_active_bidder のため、この順序が必要)。
  IF v_previous_bid_id IS NOT NULL THEN
    UPDATE public.trade_auction_bids SET status = 'withdrawn' WHERE id = v_previous_bid_id;
  END IF;

  INSERT INTO public.trade_auction_bids (
    auction_id, bidder_user_id, bid_card_id, bid_streamer_id, quantity,
    bid_card_snapshot, is_cross_channel, request_id
  ) VALUES (
    p_auction_id, v_user_id, v_card.id, v_card.streamer_id, p_quantity,
    jsonb_build_object('name', v_card.name, 'rarity', v_card.rarity, 'imageUrl', v_card.image_url),
    v_is_cross, p_request_id
  )
  RETURNING * INTO v_bid;

  INSERT INTO public.trade_auction_bid_items (bid_id, user_card_id)
  SELECT v_bid.id, unnest(v_copy_ids);

  RETURN jsonb_build_object(
    'success', true, 'bid', to_jsonb(v_bid), 'replacedBidId', v_previous_bid_id,
    'idempotentReplay', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.trade_auction_bid_unsettleable_reason(p_bid_id uuid) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_bid public.trade_auction_bids%ROWTYPE;
  v_auction public.trade_auctions%ROWTYPE;
  v_offered_active boolean;
  v_bid_active boolean;
  v_bid_wantable boolean;
  v_offered_trade boolean;
  v_offered_cross boolean;
  v_bid_trade boolean;
  v_bid_cross boolean;
  v_owned_items integer;
  v_item_count integer;
BEGIN
  SELECT * INTO v_bid FROM public.trade_auction_bids WHERE id = p_bid_id;
  IF NOT FOUND THEN
    RETURN 'BID_NOT_FOUND';
  END IF;
  SELECT * INTO v_auction FROM public.trade_auctions WHERE id = v_bid.auction_id;

  -- カード定義の削除(ON DELETE SET NULL)・無効化
  IF v_auction.offered_card_id IS NULL OR v_bid.bid_card_id IS NULL THEN
    RETURN 'AUCTION_BID_INVALID';
  END IF;
  SELECT is_active INTO v_offered_active FROM public.cards WHERE id = v_auction.offered_card_id;
  SELECT is_active, trade_wantable INTO v_bid_active, v_bid_wantable
    FROM public.cards WHERE id = v_bid.bid_card_id;
  IF v_offered_active IS NOT TRUE OR v_bid_active IS NOT TRUE THEN
    RETURN 'AUCTION_BID_INVALID';
  END IF;

  -- 配信者のトレード設定(accept_trade_offer と同じゲート。行が無ければ false = fail-closed)
  SELECT trade_enabled, cross_channel_trade_enabled INTO v_offered_trade, v_offered_cross
    FROM public.streamers WHERE id = v_auction.offered_streamer_id;
  SELECT trade_enabled, cross_channel_trade_enabled INTO v_bid_trade, v_bid_cross
    FROM public.streamers WHERE id = v_bid.bid_streamer_id;
  IF NOT COALESCE(v_offered_trade, false) OR NOT COALESCE(v_bid_trade, false) THEN
    RETURN 'TRADE_DISABLED';
  END IF;
  IF v_bid.is_cross_channel
     AND (NOT COALESCE(v_offered_cross, false) OR NOT COALESCE(v_bid_cross, false)) THEN
    RETURN 'TRADE_DISABLED';
  END IF;

  -- 入札カードは「求に指定できる」カードに限る(#1790 の制限をオークションにも適用。
  -- オーナー確定 2026-10-14)。指定不可へ変わった入札は成立させない。
  IF v_bid_wantable IS NOT TRUE THEN
    RETURN 'BID_CARD_NOT_WANTABLE';
  END IF;

  -- 出品カードの配信者が設定した「交換対象の制限」。ルールの設定後に、許可集合に
  -- 入っていない入札は成立させない(入札者は取り下げられる = この関数が非 NULL を返す入札の
  -- 既存の扱い。settle_trade_auction もこの関数を呼ぶので、出品者が選べない入札と入札者が
  -- 取り下げられる入札は常に一致する)。
  IF EXISTS (SELECT 1 FROM public.trade_wanted_restriction_rules
             WHERE offered_card_id = v_auction.offered_card_id)
     AND NOT EXISTS (SELECT 1 FROM public.trade_wanted_restriction_items
                     WHERE offered_card_id = v_auction.offered_card_id
                       AND wanted_card_id = v_bid.bid_card_id) THEN
    RETURN 'BID_CARD_NOT_ALLOWED_FOR_OFFERED';
  END IF;

  -- コピーが削除・移動していないか(出品コピーは出品者、入札コピーは全件が入札者)。
  IF NOT EXISTS (
    SELECT 1 FROM public.user_cards
    WHERE id = v_auction.offered_user_card_id AND user_id = v_auction.seller_user_id
  ) THEN
    RETURN 'AUCTION_BID_INVALID';
  END IF;
  SELECT count(*), count(uc.id) INTO v_item_count, v_owned_items
  FROM public.trade_auction_bid_items i
  LEFT JOIN public.user_cards uc ON uc.id = i.user_card_id AND uc.user_id = v_bid.bidder_user_id
  WHERE i.bid_id = v_bid.id;
  IF v_item_count <> v_bid.quantity OR v_owned_items <> v_bid.quantity THEN
    RETURN 'AUCTION_BID_INVALID';
  END IF;

  RETURN NULL;
END;
$$;

-- ============================================================
-- 6. 権限(既存のトレード RPC・テーブルと同じ。runtime ロールだけに公開する)
-- ============================================================
REVOKE ALL ON TABLE public.trade_wanted_restriction_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_wanted_restriction_rules TO service_role;
REVOKE ALL ON TABLE public.trade_wanted_restriction_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_wanted_restriction_items TO service_role;

-- CREATE OR REPLACE は既存の権限を保持するが、既存 migration と同じく明示しておく。
REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid, smallint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid, smallint) TO service_role;
REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.place_trade_auction_bid(text, uuid, uuid, smallint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_trade_auction_bid(text, uuid, uuid, smallint, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.trade_auction_bid_unsettleable_reason(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_auction_bid_unsettleable_reason(uuid) TO service_role;
