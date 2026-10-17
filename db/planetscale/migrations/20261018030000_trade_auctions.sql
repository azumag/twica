-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1791 (#715 / 問い合わせ #1788): トレードのオークション形式の出品(PR-1: DB)。
-- 仕様の正本は Issue #1791 の 2026-10-14「仕様確定」コメント群、設計は
-- tasks/plans/issue-1791-trade-auction.md(§4 が本 migration に対応する)。
--
--   - 出品者は所持カード1枚を期限(24時間 / 3日 / 7日)付きで出品する。
--   - 入札者は「1種類のカード × 1〜10枚」を提示する。入札に出したコピーは拘束する。
--   - 期限後に出品者が1件を選んで成立させる(選択期間は期限から72時間)。
--   - 状態は保存した status と DB 時刻(clock_timestamp())から導出する。Cron は無い。
--
-- 方針(expand のみ・加法的変更):
--   - 新規テーブル3つ(trade_auctions / trade_auction_bids / trade_auction_bid_items)と
--     関数の追加が主。既存テーブルへの変更は trade_offers の BEFORE INSERT トリガー
--     追加と、accept_trade_offer(4引数版)の CREATE OR REPLACE だけ。
--   - 「拘束」を一元管理する専用テーブルは作らない(計画レビュー M9)。拘束は
--     trade_copy_locked(user_card_id) という1つの判定関数で表し、すべての拘束取得・
--     移転経路(通常出品トリガー・オークション作成・入札・応諾の支払い・成立)が
--     「対象 user_cards 行を id 昇順で FOR UPDATE → 所有を再確認 → 拘束判定」の
--     同じ手順を踏む(計画レビュー M2)。同じ行のロックで直列化されるので、2つの経路が
--     同時に同じコピーを拘束することはない。専用テーブル方式で問題になる PK 衝突・
--     孤児ロック・バックフィル・期限切れロックの掃除は、構造的に発生しない。
--   - 拘束判定は関数の中で行い、ロック待ちの後に新しいスナップショットで評価される
--     「別の文」として呼ぶ(READ COMMITTED では PL/pgSQL の各文が新しいスナップショットを
--     取るため、ロック待ちの間に commit された拘束が見える)。
--   - エラーは accept_trade_offer と同じ「業務上あり得る失敗はエラーコード入り JSONB を
--     返す」方式。整合性が崩れた場合(移転件数の不一致)だけ例外で全体を巻き戻す。
--   - 権限は既存トレード RPC と同じく REVOKE ALL FROM PUBLIC, anon, authenticated +
--     service_role への GRANT(末尾)。RLS / SECURITY DEFINER を使わない理由は
--     20260817100000_add_card_trading.sql 冒頭の注記と同じ。
--
-- migration 未適用の窓(アプリと migration の適用は非同期。docs/db-driver-migration.md):
--   新アプリは拘束判定の 42P01 / 42883(テーブル・関数が無い)を「オークション・入札の
--   拘束なし」として従来の判定へ縮退し、オークション API は 503 を返す
--   (src/lib/trade.ts / src/lib/trade-auction.ts)。
--
-- 旧アプリ(ロールバック後)との互換:
--   - 旧アプリはオークションを作れないので、拘束が生じるのは新アプリが作った
--     オークション・入札だけ。旧アプリが拘束中のコピーを通常出品しようとすると、
--     トリガーの P0001 TRADE_CARD_LOCKED を知らないため 500 で拒否される
--     (データは壊れない fail-closed)。
--   - 旧アプリの応諾は accept_trade_offer を呼ぶので、拘束中のコピーは支払いに使われない。

-- このリポジトリの migration で初めて lock_timeout を設定する(baseline の pg_dump 由来の
-- `SET LOCAL lock_timeout = 0` を除く)。理由: 本 migration は既存の trade_offers に
-- CREATE TRIGGER(SHARE ROW EXCLUSIVE ロック)を取り、accept_trade_offer を置き換える。
-- 本番で長いトランザクションが trade_offers の行を持っていると、DDL のロック待ちの
-- 後ろに後続の通常の読み書きが全部並び、トレード全体が止まる(ロックキューの先頭で
-- 待つ DDL が後続の弱いロックもブロックするため)。5秒で諦めて migration ごと失敗
-- させ(トランザクションなので何も残らない)、再実行に任せる方が安全。
-- SET LOCAL なのでこのトランザクション内だけに効く(migration-transaction: required)。
SET LOCAL lock_timeout = '5s';

-- ============================================================
-- 1. trade_auctions(オークション出品)
-- ============================================================
CREATE TABLE public.trade_auctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 出品する特定の1枚。trade_offers.offered_user_card_id と同じく意図的に FK を
  -- 張らない(user_cards 行は削除されうるため、FK CASCADE だと成立済みの履歴が
  -- 消える)。コピーの削除・移動は成立時の所有確認で検出する。
  offered_user_card_id uuid NOT NULL,
  -- 一覧・フィルタ用の非正規化。カード定義削除後は NULL になり、表示はスナップショットで行う。
  offered_card_id uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  offered_streamer_id uuid NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  offered_card_snapshot jsonb NOT NULL,
  -- 入札受付の締切。作成時に clock_timestamp() + 期限で決める。
  ends_at timestamptz NOT NULL,
  -- 出品者が勝者を選べる期限(ends_at + 72時間)。作成時に保存する。後から規則を
  -- 変えても、既存オークションの約束(いつ解放されるか)が変わらないようにするため。
  selection_deadline timestamptz NOT NULL,
  -- 'expired' は将来の後処理で流札を確定保存するための値。正しさはこれに依存させず、
  -- 'open' のまま時刻を過ぎた行も trade_auction_holds_cards() で流札として扱う。
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'cancelled', 'expired')),
  -- 成立した入札。trade_auction_bids と循環参照になるため FK は張らない
  -- (settle_trade_auction だけが同じトランザクションで設定する)。
  winning_bid_id uuid,
  -- 冪等性キー: 作成用(request_id)と成立用(settle_request_id)を分離する
  -- (trade_offers の request_id / accepted_request_id と同じ考え方)。
  request_id uuid NOT NULL,
  settle_request_id uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trade_auctions_selection_after_end CHECK (selection_deadline > ends_at)
);

-- ボード(配信者別・締切順)
CREATE INDEX idx_trade_auctions_open_streamer_ends
  ON public.trade_auctions (offered_streamer_id, ends_at) WHERE status = 'open';
-- 出品上限の数え上げ・マイトレード
CREATE INDEX idx_trade_auctions_open_seller
  ON public.trade_auctions (seller_user_id) WHERE status = 'open';
CREATE UNIQUE INDEX idx_trade_auctions_seller_request
  ON public.trade_auctions (seller_user_id, request_id);
-- trade_copy_locked() の出品側の判定
CREATE INDEX idx_trade_auctions_open_user_card
  ON public.trade_auctions (offered_user_card_id) WHERE status = 'open';
-- FK 列(親の削除時のカスケード・SET NULL の走査用。trade_offers と同じ方針)
CREATE INDEX idx_trade_auctions_seller_user_id ON public.trade_auctions (seller_user_id);
CREATE INDEX idx_trade_auctions_offered_card_id ON public.trade_auctions (offered_card_id);
CREATE INDEX idx_trade_auctions_offered_streamer_id ON public.trade_auctions (offered_streamer_id);

CREATE TRIGGER update_trade_auctions_updated_at BEFORE UPDATE ON public.trade_auctions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.trade_auctions IS
  'トレードのオークション出品(#1791)。実効状態は status と clock_timestamp() から導出する(trade_auction_holds_cards 参照)。書き込みは create/cancel/settle_trade_auction RPC だけが行う。';

-- ============================================================
-- 2. trade_auction_bids / trade_auction_bid_items(入札と拘束したコピー)
-- ============================================================
CREATE TABLE public.trade_auction_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES public.trade_auctions(id) ON DELETE CASCADE,
  bidder_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 入札に出すカード種別。カード定義削除後は NULL(成立不能になり、入札者は取り下げられる)。
  bid_card_id uuid REFERENCES public.cards(id) ON DELETE SET NULL,
  bid_streamer_id uuid NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  -- 上限 10 は src/lib/trade.ts の TRADE_MAX_WANTED_QUANTITY と同値(通常出品の「求」×N と揃える)。
  quantity smallint NOT NULL CONSTRAINT trade_auction_bids_quantity_range
    CHECK (quantity BETWEEN 1 AND 10),
  bid_card_snapshot jsonb NOT NULL,
  -- 入札カードの配信者がオークションの配信者と異なるか(作成時に RPC が計算して保存する)。
  is_cross_channel boolean NOT NULL,
  -- active: 有効 / withdrawn: 取り下げ・変更で置き換え / won: 落札 / lost: 落選。
  -- 親が流札・取消になった後の active は「解放済み」と導出する(行は書き換えない)。
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'withdrawn', 'won', 'lost')),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 1人1オークションにつき有効な入札は1件(仕様)。RPC はオークション行のロック下で
-- 旧入札を withdrawn にしてから新入札を INSERT するので、この索引は最後の防御。
CREATE UNIQUE INDEX idx_trade_auction_bids_active_bidder
  ON public.trade_auction_bids (auction_id, bidder_user_id) WHERE status = 'active';
CREATE UNIQUE INDEX idx_trade_auction_bids_bidder_request
  ON public.trade_auction_bids (bidder_user_id, request_id);
-- 有効入札の上限(1人10件)の数え上げ
CREATE INDEX idx_trade_auction_bids_active_by_bidder
  ON public.trade_auction_bids (bidder_user_id) WHERE status = 'active';
CREATE INDEX idx_trade_auction_bids_auction_id ON public.trade_auction_bids (auction_id);
CREATE INDEX idx_trade_auction_bids_bid_card_id ON public.trade_auction_bids (bid_card_id);
CREATE INDEX idx_trade_auction_bids_bid_streamer_id ON public.trade_auction_bids (bid_streamer_id);

CREATE TRIGGER update_trade_auction_bids_updated_at BEFORE UPDATE ON public.trade_auction_bids
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE public.trade_auction_bids IS
  'オークションへの入札(#1791)。1種類のカード × quantity 枚。拘束した具体的なコピーは trade_auction_bid_items に持つ。書き込みは place/withdraw_trade_auction_bid と settle_trade_auction だけが行う。';

CREATE TABLE public.trade_auction_bid_items (
  bid_id uuid NOT NULL REFERENCES public.trade_auction_bids(id) ON DELETE CASCADE,
  -- 拘束したコピー。offered_user_card_id と同じ理由で FK は張らない。
  user_card_id uuid NOT NULL,
  PRIMARY KEY (bid_id, user_card_id)
);

-- trade_copy_locked() の入札側の判定
CREATE INDEX idx_trade_auction_bid_items_user_card_id
  ON public.trade_auction_bid_items (user_card_id);

COMMENT ON TABLE public.trade_auction_bid_items IS
  '入札が拘束しているコピー(#1791)。行は入札と同時に作られ、以後変わらない。拘束中かどうかは親の入札・オークションの状態から導出する(trade_copy_locked)。';

-- ============================================================
-- 3. 拘束の判定
-- ============================================================
-- オークションが「カードを拘束している」実効状態か(設計 §3 の bidding / selecting)。
--   bidding:   status='open' かつ t < ends_at
--   selecting: status='open' かつ t < selection_deadline かつ 有効入札 > 0
-- それ以外(入札0件で期限到来・選択期間切れ・成立・取消)は拘束しない。
-- 入札0件のまま期限が来たら、その時点で出品カードを解放する(72時間待たない。計画レビュー M7)。
--
-- 時刻は Worker ではなく DB の clock_timestamp() を使う。now() はトランザクション開始
-- 時刻で固定され、行ロック待ちの間も進まないため、境界をまたいだ誤判定になる
-- (計画レビュー M3)。clock_timestamp() は VOLATILE なので、関数も VOLATILE と宣言する
-- (STABLE と偽ると、プランナーが同じ文の中で結果を使い回してよいことになるため)。
CREATE FUNCTION public.trade_auction_holds_cards(p_auction_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.trade_auctions a
    WHERE a.id = p_auction_id
      AND a.status = 'open'
      AND (
        clock_timestamp() < a.ends_at
        OR (
          clock_timestamp() < a.selection_deadline
          AND EXISTS (
            SELECT 1 FROM public.trade_auction_bids b
            WHERE b.auction_id = a.id AND b.status = 'active'
          )
        )
      )
  )
$$;

-- コピーがオークションの出品か有効な入札で拘束中か。
-- trade_offers の BEFORE INSERT トリガーはこちらだけを使う。通常出品どうしの重複は
-- 既存の部分UNIQUE(idx_trade_offers_open_user_card)の 23505 に任せ、旧アプリが
-- 知っている従来の挙動(ALREADY_LISTED)を変えないため。
CREATE FUNCTION public.trade_copy_auction_locked(p_user_card_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.trade_auctions a
      WHERE a.offered_user_card_id = p_user_card_id
        AND a.status = 'open'
        AND public.trade_auction_holds_cards(a.id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.trade_auction_bid_items i
      JOIN public.trade_auction_bids b ON b.id = i.bid_id
      WHERE i.user_card_id = p_user_card_id
        AND b.status = 'active'
        AND public.trade_auction_holds_cards(b.auction_id)
    )
$$;

-- コピーが拘束中か(open な通常出品・オークションの出品・有効な入札のいずれか)。
-- 拘束中のコピーは、他の出品・入札・応諾の支払いに使えない。
-- 呼び出し側は事前に当該 user_cards 行を FOR UPDATE し、所有を再確認していること
-- (この関数自体はロックを取らない)。
-- 将来、休眠中の石交換 RPC(exchange_duplicate_card_for_stones)を公開する場合は、
-- この判定を追加する必要がある(設計 §7)。
CREATE FUNCTION public.trade_copy_locked(p_user_card_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.trade_offers o
      WHERE o.offered_user_card_id = p_user_card_id AND o.status = 'open'
    )
    OR public.trade_copy_auction_locked(p_user_card_id)
$$;

-- ============================================================
-- 4. 通常出品(trade_offers)への拘束の適用
-- ============================================================
-- 通常出品の INSERT はアプリ(src/lib/trade.ts createTradeOffer)が直接行うため、
-- 拘束の排他は BEFORE INSERT トリガーで DB 側に置く(アプリの事前チェックは補助)。
--   * 出品コピーの user_cards 行を FOR UPDATE する。入札・オークション作成・成立も
--     同じ行をロックするので、ここで直列化される。
--   * 所有を再確認する。ロック待ちの間に成立(settle_trade_auction)でコピーが別の
--     利用者へ移った場合は P0001 TRADE_CARD_NOT_OWNED で拒否する。許すと、新しい
--     所有者のコピーが他人の open な通常出品に「出品中」として拘束され、新しい所有者は
--     その出品を取り消せない。
--     コピーの行そのものが無い場合(削除済み)は拒否しない。従来どおり INSERT を通し、
--     応諾時に accept_trade_offer が OFFER_INVALID で cancelled にする(誰のコピーも
--     拘束しないので害が無く、既存の契約と tests/fixtures/add-card-trading-postgres.sql の
--     前提を変えないため)。
--   * オークション・入札で拘束中なら P0001 TRADE_CARD_LOCKED で拒否する。新アプリは
--     TRADE_CARD_ALREADY_LISTED にマップする(計画レビュー M1)。
-- status='open' 以外の INSERT(手動の履歴投入など)は対象外。
CREATE FUNCTION public.trade_offers_enforce_copy_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM 'open' THEN
    RETURN NEW;
  END IF;

  SELECT user_id INTO v_owner
  FROM public.user_cards
  WHERE id = NEW.offered_user_card_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_owner IS DISTINCT FROM NEW.offerer_user_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRADE_CARD_NOT_OWNED';
  END IF;

  -- 別の文として評価するので、ロック待ちの間に commit された入札も見える。
  IF public.trade_copy_auction_locked(NEW.offered_user_card_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRADE_CARD_LOCKED';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trade_offers_enforce_copy_lock BEFORE INSERT ON public.trade_offers
  FOR EACH ROW EXECUTE FUNCTION public.trade_offers_enforce_copy_lock();

-- ============================================================
-- 5. accept_trade_offer(4引数版)の置き換え
-- ============================================================
-- 20261014100000_card_trade_wantable.sql の4引数版から、支払いコピーの除外条件を
-- trade_copy_locked(id) に変え、(3) の数え直しにも拘束判定を加えたもの(2か所+
-- コメント)。返却 JSON・エラーコード・ロック順・冪等リプレイ・3引数ラッパーは不変
-- (差分は tests/unit/trade-auction-migration.test.ts で固定する)。新しいエラーコードは
-- 増えないので、3引数ラッパーは置き換えない。
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
  'トレードオファーの応諾(#1789/#1790/#1791)。p_expected_quantity がオファーの wanted_quantity と一致し(不一致は QUANTITY_MISMATCH)、求めるカードの cards.trade_wantable が true の場合(false は WANTED_CARD_NOT_WANTABLE、オファーは open のまま)だけ、応諾者の wanted_card_id コピーのうち拘束されていないもの(trade_copy_locked = false: 通常出品・オークション出品・有効な入札のいずれにも使われていない)を wanted_quantity 枚まとめて移転する。FOR UPDATE ロック+エラーコードJSONB返却でOFFER_INVALID系のcancelled更新をコミット可能にする。詳細はtasks/plans/issue-715-card-trading.md §4.4、tasks/plans/issue-1791-trade-auction.md §4.1。';

-- ============================================================
-- 6. 入札が成立できる状態か(取り下げ・成立の共通判定)
-- ============================================================
-- 成立できないなら、その理由のエラーコードを返す(できるなら NULL)。
-- 仕様(#1791 2026-10-14): 締切後に成立できない状態(配信者のトレード設定OFF、カードの
-- 無効化・削除、求に指定不可への変更)になった入札は、入札者が取り下げられる。
-- settle_trade_auction も同じ判定で拒否するので、「出品者が選べない入札」と
-- 「入札者が取り下げられる入札」は常に一致する(どちらからも動かせない入札を作らない)。
-- 所有の確認はロックなしの読み取り。settle_trade_auction はロック取得後にもう一度確認する。
-- オークションの status / 時刻は見ない(呼び出し側がロック下で判定する)。
CREATE FUNCTION public.trade_auction_bid_unsettleable_reason(p_bid_id uuid) RETURNS text
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
-- 7. create_trade_auction(出品)
-- ============================================================
-- 手順: 冪等リプレイ → 期限の検証 → 出品コピーの user_cards 行を FOR UPDATE →
-- (ロック後に)冪等リプレイの再確認 → 所有 → カード有効性 → 設定ゲート →
-- 出品上限 → 拘束判定 → INSERT。
CREATE FUNCTION public.create_trade_auction(
  p_twitch_user_id text,
  p_user_card_id uuid,
  p_duration_hours integer,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id uuid;
  v_auction public.trade_auctions%ROWTYPE;
  v_copy_owner uuid;
  v_card public.cards%ROWTYPE;
  v_trade_enabled boolean;
  v_open_count integer;
  v_ends_at timestamptz;
BEGIN
  IF p_twitch_user_id IS NULL OR p_user_card_id IS NULL OR p_duration_hours IS NULL
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT id INTO v_user_id FROM public.users WHERE twitch_user_id = p_twitch_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  END IF;

  -- 冪等リプレイ(すべての検証より前)。成立後の再送が、その後の設定変更などで
  -- 失敗扱いにならないようにする(createTradeOffer と同じ順序)。
  SELECT * INTO v_auction FROM public.trade_auctions
  WHERE seller_user_id = v_user_id AND request_id = p_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'auction', to_jsonb(v_auction), 'idempotentReplay', true);
  END IF;

  -- 期限は 24時間 / 3日 / 7日 のいずれか(アプリも検証する。ここは最後の防御)。
  IF p_duration_hours NOT IN (24, 72, 168) THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_DURATION');
  END IF;

  -- 出品コピーの行ロック。所有者で絞らずにロックし、所有はロック後の行で確認する
  -- (絞ってロックすると、同じ requestId の並行再送でコピーが既に移った場合などに
  -- 「見つからない」と「他人の物」の区別が付かないため)。
  SELECT user_id INTO v_copy_owner FROM public.user_cards WHERE id = p_user_card_id FOR UPDATE;

  -- 同じ requestId の並行再送は上のロックで直列化される。先行が commit した行は
  -- この新しい文から見えるので、ここでもう一度リプレイを確認する(INSERT の 23505 を防ぐ)。
  SELECT * INTO v_auction FROM public.trade_auctions
  WHERE seller_user_id = v_user_id AND request_id = p_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'auction', to_jsonb(v_auction), 'idempotentReplay', true);
  END IF;

  IF v_copy_owner IS DISTINCT FROM v_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_OWNED');
  END IF;

  SELECT c.* INTO v_card FROM public.cards c
  JOIN public.user_cards uc ON uc.card_id = c.id
  WHERE uc.id = p_user_card_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_NOT_OWNED');
  END IF;
  -- 無効なカード定義(引退カード・パック完走報酬カード)はトレード市場に出せない。
  IF v_card.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFERED_CARD_INACTIVE');
  END IF;

  -- 出品はそのカードの配信者のチャンネルで行う。クロスチャンネルの可否は入札時に判定する。
  SELECT trade_enabled INTO v_trade_enabled FROM public.streamers WHERE id = v_card.streamer_id;
  IF NOT COALESCE(v_trade_enabled, false) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRADE_DISABLED');
  END IF;

  -- 出品上限: open な通常出品とオークション出品(拘束中 = 受付中・選択待ち)の合計で
  -- TRADE_MAX_OPEN_OFFERS(10)を共用する(仕様)。導出上の流札は数えない。
  -- 並行する別コピーの出品とは直列化しないので、瞬間的に上限を1件程度超えうる
  -- (createTradeOffer の数え上げと同じ許容。上限は乱用防止の目安で、整合性の条件ではない)。
  SELECT
    (SELECT count(*) FROM public.trade_offers
      WHERE offerer_user_id = v_user_id AND status = 'open')
    + (SELECT count(*) FROM public.trade_auctions a
      WHERE a.seller_user_id = v_user_id AND a.status = 'open'
        AND public.trade_auction_holds_cards(a.id))
  INTO v_open_count;
  IF v_open_count >= 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_LIMIT');
  END IF;

  IF public.trade_copy_locked(p_user_card_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'CARD_ALREADY_LISTED');
  END IF;

  v_ends_at := clock_timestamp() + make_interval(hours => p_duration_hours);
  INSERT INTO public.trade_auctions (
    seller_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
    offered_card_snapshot, ends_at, selection_deadline, request_id
  ) VALUES (
    v_user_id, p_user_card_id, v_card.id, v_card.streamer_id,
    jsonb_build_object('name', v_card.name, 'rarity', v_card.rarity, 'imageUrl', v_card.image_url),
    v_ends_at, v_ends_at + interval '72 hours', p_request_id
  )
  RETURNING * INTO v_auction;

  RETURN jsonb_build_object('success', true, 'auction', to_jsonb(v_auction), 'idempotentReplay', false);
END;
$$;

-- ============================================================
-- 8. place_trade_auction_bid(入札・入札変更)
-- ============================================================
-- ロック順: オークション行 → (旧入札行) → 入札者の user_cards 行。
-- 可視性(入札カードが出品者に見える・出品カードが入札者に見える)は、既存の可視性規則
-- (src/lib/trade.ts cardVisibleTo)を再利用するためアプリ層の事前チェックで行う
-- (accept の precheckTradeAccept と同じ分担。規則を SQL に二重実装しない)。
CREATE FUNCTION public.place_trade_auction_bid(
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
  PERFORM 1
  FROM public.user_cards
  WHERE user_id = v_user_id AND card_id = p_bid_card_id
  ORDER BY id
  FOR UPDATE;

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

-- ============================================================
-- 9. withdraw_trade_auction_bid(入札の取り下げ)
-- ============================================================
-- 状態として冪等(取り下げ済みの再送は成功)なので request_id を取らない。
-- 許可条件: 受付中(t < ends_at)、または選択期間中で成立できない状態
-- (trade_auction_bid_unsettleable_reason が非 NULL)。選択期間が過ぎた入札は既に
-- 解放済みで、取り下げても害が無いので許可する(マイトレードの整理用)。
CREATE FUNCTION public.withdraw_trade_auction_bid(
  p_twitch_user_id text,
  p_bid_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id uuid;
  v_auction_id uuid;
  v_auction public.trade_auctions%ROWTYPE;
  v_bid public.trade_auction_bids%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_twitch_user_id IS NULL OR p_bid_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT id INTO v_user_id FROM public.users WHERE twitch_user_id = p_twitch_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  END IF;

  -- ロック順(オークション → 入札)を守るため、まずロックなしで auction_id だけ読む。
  -- auction_id は不変なので、この読み取りが古くても問題ない。
  SELECT auction_id INTO v_auction_id FROM public.trade_auction_bids WHERE id = p_bid_id;
  IF v_auction_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'BID_NOT_FOUND');
  END IF;

  SELECT * INTO v_auction FROM public.trade_auctions WHERE id = v_auction_id FOR UPDATE;
  SELECT * INTO v_bid FROM public.trade_auction_bids WHERE id = p_bid_id FOR UPDATE;

  -- 他人の入札は存在自体を明かさない。
  IF v_bid.bidder_user_id IS DISTINCT FROM v_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'BID_NOT_FOUND');
  END IF;

  IF v_bid.status = 'withdrawn' THEN
    RETURN jsonb_build_object('success', true, 'bidId', v_bid.id, 'alreadyWithdrawn', true);
  END IF;
  IF v_bid.status <> 'active' OR v_auction.status <> 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'BID_NOT_ACTIVE');
  END IF;

  v_now := clock_timestamp();
  IF v_now >= v_auction.ends_at
     AND v_now < v_auction.selection_deadline
     AND public.trade_auction_bid_unsettleable_reason(v_bid.id) IS NULL THEN
    -- 選択待ちで、出品者が成立させられる入札。仕様により取り下げられない。
    RETURN jsonb_build_object('success', false, 'error', 'BID_WITHDRAW_LOCKED');
  END IF;

  UPDATE public.trade_auction_bids SET status = 'withdrawn' WHERE id = v_bid.id;
  RETURN jsonb_build_object('success', true, 'bidId', v_bid.id, 'alreadyWithdrawn', false);
END;
$$;

-- ============================================================
-- 10. cancel_trade_auction(出品の取消)
-- ============================================================
-- 有効な入札が1件でもあれば取り消せない。有効な入札が0件なら、期限の前後に関係なく
-- 取り消せる(計画レビュー M7)。選択期間を過ぎたオークションは既に流札(全カード
-- 解放済み)なので、入札の有無に関係なく取消として記録してよい。
CREATE FUNCTION public.cancel_trade_auction(
  p_twitch_user_id text,
  p_auction_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id uuid;
  v_auction public.trade_auctions%ROWTYPE;
BEGIN
  IF p_twitch_user_id IS NULL OR p_auction_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT id INTO v_user_id FROM public.users WHERE twitch_user_id = p_twitch_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  END IF;

  SELECT * INTO v_auction FROM public.trade_auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND OR v_auction.seller_user_id <> v_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_FOUND');
  END IF;

  IF v_auction.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', true, 'auctionId', v_auction.id, 'alreadyCancelled', true);
  END IF;
  IF v_auction.status <> 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_OPEN');
  END IF;

  -- 入札は同じオークション行のロック下でしか増減しないので、この数は確定している。
  IF clock_timestamp() < v_auction.selection_deadline AND EXISTS (
    SELECT 1 FROM public.trade_auction_bids
    WHERE auction_id = v_auction.id AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_HAS_BIDS');
  END IF;

  UPDATE public.trade_auctions SET status = 'cancelled' WHERE id = v_auction.id;
  RETURN jsonb_build_object('success', true, 'auctionId', v_auction.id, 'alreadyCancelled', false);
END;
$$;

-- ============================================================
-- 11. settle_trade_auction(出品者による成立)
-- ============================================================
-- ロック順: オークション行 → 入札行 → 出品コピーと入札コピー(id 昇順)。
-- 移転と状態の確定は1トランザクション(accept_trade_offer と同じく途中失敗の
-- 巻き戻しを不要にする)。成立できない入札はエラーを返すだけで何も書かないので、
-- 出品者は別の入札を選べる。
CREATE FUNCTION public.settle_trade_auction(
  p_twitch_user_id text,
  p_auction_id uuid,
  p_bid_id uuid,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id uuid;
  v_auction public.trade_auctions%ROWTYPE;
  v_bid public.trade_auction_bids%ROWTYPE;
  v_now timestamptz;
  v_reason text;
  v_item_ids uuid[];
  v_owned_count integer;
  v_listed_count integer;
  v_update_count integer;
BEGIN
  IF p_twitch_user_id IS NULL OR p_auction_id IS NULL OR p_bid_id IS NULL
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  SELECT id INTO v_user_id FROM public.users WHERE twitch_user_id = p_twitch_user_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  END IF;

  -- 1. オークション行をロック
  SELECT * INTO v_auction FROM public.trade_auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND OR v_auction.seller_user_id <> v_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_FOUND');
  END IF;

  -- 2. 冪等リプレイ(すべての検証より前)。同じ requestId で同じ入札を選んだ再送だけ。
  IF v_auction.status = 'completed'
     AND v_auction.settle_request_id = p_request_id
     AND v_auction.winning_bid_id = p_bid_id THEN
    SELECT * INTO v_bid FROM public.trade_auction_bids WHERE id = p_bid_id;
    SELECT array_agg(user_card_id ORDER BY user_card_id) INTO v_item_ids
      FROM public.trade_auction_bid_items WHERE bid_id = p_bid_id;
    RETURN jsonb_build_object(
      'success', true,
      'auctionId', v_auction.id,
      'bidId', p_bid_id,
      'givenUserCardId', v_auction.offered_user_card_id,
      'receivedUserCardIds', to_jsonb(v_item_ids),
      'quantity', v_bid.quantity,
      'offeredCardSnapshot', v_auction.offered_card_snapshot,
      'bidCardSnapshot', v_bid.bid_card_snapshot,
      'completedAt', v_auction.completed_at,
      'idempotentReplay', true
    );
  END IF;

  -- 3. 状態と時刻(ロック取得後に clock_timestamp() で判定)
  IF v_auction.status <> 'open' THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_OPEN');
  END IF;
  v_now := clock_timestamp();
  IF v_now < v_auction.ends_at THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_STILL_BIDDING');
  END IF;
  IF v_now >= v_auction.selection_deadline THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_EXPIRED');
  END IF;

  -- 4. 入札行をロック
  SELECT * INTO v_bid FROM public.trade_auction_bids
  WHERE id = p_bid_id AND auction_id = p_auction_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'BID_NOT_FOUND');
  END IF;
  IF v_bid.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'BID_NOT_ACTIVE');
  END IF;

  -- 5. 成立できる状態か(設定ゲート・両カードの有効性・入札カードの trade_wantable・所有)
  v_reason := public.trade_auction_bid_unsettleable_reason(v_bid.id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_reason);
  END IF;

  -- 6. 出品コピーと入札コピーを id 昇順でロックし、ロック後の所有者で数え直す
  SELECT array_agg(user_card_id ORDER BY user_card_id) INTO v_item_ids
    FROM public.trade_auction_bid_items WHERE bid_id = v_bid.id;

  PERFORM 1 FROM public.user_cards
  WHERE id = ANY (v_item_ids || v_auction.offered_user_card_id)
  ORDER BY id
  FOR UPDATE;

  SELECT
    count(*) FILTER (WHERE id = ANY (v_item_ids) AND user_id = v_bid.bidder_user_id)
    + count(*) FILTER (WHERE id = v_auction.offered_user_card_id AND user_id = v_auction.seller_user_id)
  INTO v_owned_count
  FROM public.user_cards
  WHERE id = ANY (v_item_ids || v_auction.offered_user_card_id);
  IF v_owned_count <> v_bid.quantity + 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_BID_INVALID');
  END IF;

  -- 防御: 対象コピーが通常出品に使われていないこと。トリガーにより拘束中のコピーは
  -- 通常出品できないので到達しないが、使われていれば二重譲渡になるため移転しない。
  SELECT count(*) INTO v_listed_count FROM public.trade_offers
  WHERE offered_user_card_id = ANY (v_item_ids || v_auction.offered_user_card_id)
    AND status = 'open';
  IF v_listed_count <> 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_BID_INVALID');
  END IF;

  -- 7. 所有権移転(入札コピー群 → 出品者、出品コピー → 入札者)。件数が合わなければ
  --    部分移転をコミットしないよう例外で全体を巻き戻す((6) のロック下では到達しない)。
  UPDATE public.user_cards SET user_id = v_auction.seller_user_id, obtained_at = now()
    WHERE id = ANY (v_item_ids) AND user_id = v_bid.bidder_user_id;
  GET DIAGNOSTICS v_update_count = ROW_COUNT;
  IF v_update_count <> v_bid.quantity THEN
    RAISE EXCEPTION 'TRADE_AUCTION_TRANSFER_MISMATCH';
  END IF;

  UPDATE public.user_cards SET user_id = v_bid.bidder_user_id, obtained_at = now()
    WHERE id = v_auction.offered_user_card_id AND user_id = v_auction.seller_user_id;
  GET DIAGNOSTICS v_update_count = ROW_COUNT;
  IF v_update_count <> 1 THEN
    RAISE EXCEPTION 'TRADE_AUCTION_TRANSFER_MISMATCH';
  END IF;

  -- 8. 状態の確定(選ばれなかった有効入札は lost = 解放)
  UPDATE public.trade_auction_bids SET status = 'won' WHERE id = v_bid.id;
  UPDATE public.trade_auction_bids SET status = 'lost'
    WHERE auction_id = v_auction.id AND status = 'active' AND id <> v_bid.id;
  UPDATE public.trade_auctions SET
    status = 'completed',
    winning_bid_id = v_bid.id,
    settle_request_id = p_request_id,
    completed_at = now()
  WHERE id = v_auction.id;

  RETURN jsonb_build_object(
    'success', true,
    'auctionId', v_auction.id,
    'bidId', v_bid.id,
    'givenUserCardId', v_auction.offered_user_card_id,
    'receivedUserCardIds', to_jsonb(v_item_ids),
    'quantity', v_bid.quantity,
    'offeredCardSnapshot', v_auction.offered_card_snapshot,
    'bidCardSnapshot', v_bid.bid_card_snapshot,
    'completedAt', now(),
    'idempotentReplay', false
  );
END;
$$;

-- ============================================================
-- 12. 権限(既存トレード RPC と同じ方針)
-- ============================================================
REVOKE ALL ON TABLE public.trade_auctions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_auctions TO service_role;
REVOKE ALL ON TABLE public.trade_auction_bids FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_auction_bids TO service_role;
REVOKE ALL ON TABLE public.trade_auction_bid_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_auction_bid_items TO service_role;

REVOKE ALL ON FUNCTION public.trade_auction_holds_cards(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_auction_holds_cards(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.trade_copy_auction_locked(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_copy_auction_locked(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.trade_copy_locked(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_copy_locked(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.trade_offers_enforce_copy_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trade_auction_bid_unsettleable_reason(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_auction_bid_unsettleable_reason(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.create_trade_auction(text, uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_trade_auction(text, uuid, integer, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.place_trade_auction_bid(text, uuid, uuid, smallint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_trade_auction_bid(text, uuid, uuid, smallint, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.withdraw_trade_auction_bid(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_trade_auction_bid(text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.cancel_trade_auction(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_trade_auction(text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.settle_trade_auction(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_trade_auction(text, uuid, uuid, uuid) TO service_role;

-- CREATE OR REPLACE は既存の権限を保持するが、既存 migration と同じく明示しておく。
REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid, smallint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid, smallint) TO service_role;
