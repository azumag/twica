#!/usr/bin/env bash
set -euo pipefail

# Issue #1791 (トレードのオークション形式): 2接続の並行実行でしか再現できない
# 不変条件を、実際の PostgreSQL 17 で検証する(設計 tasks/plans/issue-1791-trade-auction.md §8)。
# 単一トランザクションの fixture や vitest の統合テストでは、接続間の行ロック待ちと
# 「ロック待ちの間に進む時刻」を再現できないため。
#
# 各シナリオは「接続1がトランザクションを開いたまま行ロックを持って待つ → 接続2が
# 同じ行を必要とする操作を始めてブロックされる → 接続1が COMMIT → 接続2が続行」と
# いう順序で組む。順序は固定の sleep ではなく pg_stat_activity のポーリングで作る
# (接続1が pg_sleep に入った = ロックを取った、接続2が Lock 待ちに入った、DB 時刻が
# 期限を越えた、を確かめてから次へ進む)。固定の sleep だと、接続1の起動が遅れた
# 環境で接続2が先にロックを取り、検証したい順序にならない(実際に起きた)。
#
#   S1 入札 × 通常出品(トリガー): 入札が拘束したコピーを、ロック待ち後のトリガーが
#      TRADE_CARD_LOCKED で拒否する(入札が先に commit)。
#   S2 通常出品 × 入札: 出品が先に commit したコピーを、ロック待ち後の入札が
#      使わない(NOT_ENOUGH_CARDS)。
#   S3 入札 × 応諾の支払い: 入札が先に拘束したコピーを、ロック待ち後の
#      accept_trade_offer が支払いに使わない(CARD_NOT_OWNED、移転なし)。
#   S4 入札変更 × 成立(期限境界): 成立はオークション行のロック取得「後」の
#      clock_timestamp() で判定するので、ロック待ちの間に期限を越えたら選択期間として
#      扱い、入札変更で置き換えられた旧入札を BID_NOT_ACTIVE で拒否する
#      (now() で判定していれば、トランザクション開始時刻が期限前なので
#      AUCTION_STILL_BIDDING になる)。
#   S5 入札 × 入札期限: ロック待ちの間に ends_at を越えた入札は AUCTION_NOT_OPEN。
#   S6 成立 × 選択期限: ロック待ちの間に selection_deadline を越えた成立は
#      AUCTION_EXPIRED で、何も移転しない。
#   S7 入札 × 出品コピーの通常出品(入札期限をまたぐ): 入札が出品コピーもロックするので、
#      締切後に commit した入札と通常出品が同じコピーを二重に拘束しない。
#   S8 成立 × 選択期限 × 別オークションへの入札: 成立はコピーのロック取得後に選択期限を
#      再判定するので、期限後に別の入札が取ったコピーを出品者へ移さない。
#   (S7/S8 は PR #1850 の独立レビュー必須指摘 M1 の回帰テスト。修正前の migration で
#    失敗することを確認済み。)
#
# すべての psql に statement_timeout / lock_timeout を付け、想定外のロック待ちで
# CI が止まらないようにする。一時ファイルは trap で削除する。

readonly DB_HOST="${PGHOST:-127.0.0.1}"
readonly DB_PORT="${PGPORT:-5432}"
readonly DB_USER="${PGUSER:-postgres}"
readonly DB_NAME="${PGDATABASE:-postgres}"
export PGOPTIONS="-c statement_timeout=20000 -c lock_timeout=15000"
readonly PSQL=(psql -X -qAt -v ON_ERROR_STOP=1 \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME")

readonly P='32000000-0000-4100-8100-'
readonly STREAMER_ID="${P}000000000001"
readonly SELLER_ID="${P}0000000000a1"
readonly BIDDER1_ID="${P}0000000000a2"
readonly BIDDER2_ID="${P}0000000000a3"
readonly BIDDER3_ID="${P}0000000000a4"
readonly OFFERER_ID="${P}0000000000a5"
readonly BIDDER4_ID="${P}0000000000a6"
readonly BIDDER5_ID="${P}0000000000a7"
readonly MAIN_CARD_ID="${P}0000000000c1"
readonly COIN_CARD_ID="${P}0000000000c2"
readonly GEM_CARD_ID="${P}0000000000c3"
# seller の出品コピー(オークション1件につき1枚)
readonly M1="${P}0000000000d1"
readonly M2="${P}0000000000d2"
readonly M3="${P}0000000000d3"
readonly M4="${P}0000000000d4"
readonly M5="${P}0000000000d5"
# S7/S8 用。S8 は「出品コピー(d6)の id < 入札コピー(e8)の id」であることが前提
# (settle が id 昇順で出品コピーのロックを待っている間に、入札コピーが別の入札に取られる)。
readonly M6="${P}0000000000d6"
readonly M7="${P}0000000000d7"
readonly M8="${P}0000000000d8"
# bidder1 の coin 2枚(S1/S2)、bidder2 の coin 1枚(S3)、bidder3 の coin 2枚(S4)、
# bidder1 の gem 1枚(S6 の入札)、offerer の gem 1枚(S3 の通常出品)
readonly K1="${P}0000000000e1"
readonly K2="${P}0000000000e2"
readonly K3="${P}0000000000e3"
readonly K4="${P}0000000000e4"
readonly K5="${P}0000000000e5"
readonly G1="${P}0000000000e6"
readonly G2="${P}0000000000e7"
# bidder5 の coin(S8)、bidder4 の coin(S7)
readonly K8="${P}0000000000e8"
readonly K9="${P}0000000000e9"
readonly OFFER_ID="${P}0000000000f1"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

rid() {
  # 冪等キー用の UUID(各 RPC 呼び出しで新しいもの)
  "${PSQL[@]}" -c "SELECT gen_random_uuid()"
}

fail() {
  echo "trade-auction concurrency: $*" >&2
  exit 1
}

# 条件($1: SQL の boolean 式)が真になるまで最大10秒ポーリングする。
wait_until() {
  local _
  for _ in $(seq 1 100); do
    if [[ "$("${PSQL[@]}" -c "SELECT ($1)")" == "t" ]]; then
      return 0
    fi
    sleep 0.1
  done
  fail "timed out waiting for: $1"
}

# application_name = $1 の接続が pg_sleep 中(= それより前の文のロックを保持中)か。
sleeping() {
  echo "EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '$1' AND state = 'active' AND query LIKE '%pg_sleep%' AND wait_event = 'PgSleep')"
}

# application_name = $1 の接続が行ロック待ちでブロックされているか。
blocked() {
  echo "EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '$1' AND wait_event_type = 'Lock')"
}

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
"${PSQL[@]}" -1 <<SQL
INSERT INTO public.streamers (
  id, twitch_user_id, twitch_username, twitch_display_name,
  trade_enabled, cross_channel_trade_enabled, show_unowned_cards, show_unowned_card_details
) VALUES ('$STREAMER_ID', 'ta-conc-streamer', 'ta-conc-streamer', 'TA Conc', true, true, true, true);

INSERT INTO public.users (id, twitch_user_id, twitch_username, twitch_display_name) VALUES
  ('$SELLER_ID', 'ta-conc-seller', 'ta-conc-seller', 'Seller'),
  ('$BIDDER1_ID', 'ta-conc-bidder1', 'ta-conc-bidder1', 'Bidder1'),
  ('$BIDDER2_ID', 'ta-conc-bidder2', 'ta-conc-bidder2', 'Bidder2'),
  ('$BIDDER3_ID', 'ta-conc-bidder3', 'ta-conc-bidder3', 'Bidder3'),
  ('$OFFERER_ID', 'ta-conc-offerer', 'ta-conc-offerer', 'Offerer'),
  ('$BIDDER4_ID', 'ta-conc-bidder4', 'ta-conc-bidder4', 'Bidder4'),
  ('$BIDDER5_ID', 'ta-conc-bidder5', 'ta-conc-bidder5', 'Bidder5');

INSERT INTO public.cards (id, streamer_id, name, rarity, drop_rate, is_active) VALUES
  ('$MAIN_CARD_ID', '$STREAMER_ID', 'Conc Main', 'rare', 0.34, true),
  ('$COIN_CARD_ID', '$STREAMER_ID', 'Conc Coin', 'common', 0.33, true),
  ('$GEM_CARD_ID', '$STREAMER_ID', 'Conc Gem', 'epic', 0.33, true);

INSERT INTO public.user_cards (id, user_id, card_id, obtained_at) VALUES
  ('$M1', '$SELLER_ID', '$MAIN_CARD_ID', now() - interval '10 minutes'),
  ('$M2', '$SELLER_ID', '$MAIN_CARD_ID', now() - interval '9 minutes'),
  ('$M3', '$SELLER_ID', '$MAIN_CARD_ID', now() - interval '8 minutes'),
  ('$M4', '$SELLER_ID', '$MAIN_CARD_ID', now() - interval '7 minutes'),
  ('$M5', '$SELLER_ID', '$MAIN_CARD_ID', now() - interval '6 minutes'),
  ('$K1', '$BIDDER1_ID', '$COIN_CARD_ID', now() - interval '10 minutes'),
  ('$K2', '$BIDDER1_ID', '$COIN_CARD_ID', now() - interval '9 minutes'),
  ('$K3', '$BIDDER2_ID', '$COIN_CARD_ID', now() - interval '8 minutes'),
  ('$K4', '$BIDDER3_ID', '$COIN_CARD_ID', now() - interval '7 minutes'),
  ('$K5', '$BIDDER3_ID', '$COIN_CARD_ID', now() - interval '6 minutes'),
  ('$G1', '$BIDDER1_ID', '$GEM_CARD_ID', now() - interval '5 minutes'),
  ('$G2', '$OFFERER_ID', '$GEM_CARD_ID', now() - interval '4 minutes'),
  ('$M6', '$SELLER_ID', '$MAIN_CARD_ID', now() - interval '5 minutes'),
  ('$M7', '$SELLER_ID', '$MAIN_CARD_ID', now() - interval '4 minutes'),
  ('$M8', '$SELLER_ID', '$MAIN_CARD_ID', now() - interval '3 minutes'),
  ('$K8', '$BIDDER5_ID', '$COIN_CARD_ID', now() - interval '3 minutes'),
  ('$K9', '$BIDDER4_ID', '$COIN_CARD_ID', now() - interval '2 minutes');

-- S3: offerer の gem を coin ×1 と交換する通常出品
INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '$OFFER_ID', '$OFFERER_ID', '$G2', '$GEM_CARD_ID', '$STREAMER_ID',
  '$COIN_CARD_ID', '$STREAMER_ID',
  '{"name": "Conc Gem", "rarity": "epic", "imageUrl": null}'::jsonb,
  '{"name": "Conc Coin", "rarity": "common", "imageUrl": null}'::jsonb
);
SQL

auction_id_of() {
  "${PSQL[@]}" -c "SELECT id FROM public.trade_auctions WHERE offered_user_card_id = '$1' AND status = 'open'"
}

for copy in "$M1" "$M2" "$M3" "$M4" "$M5" "$M6" "$M7" "$M8"; do
  result="$("${PSQL[@]}" -c "SELECT public.create_trade_auction('ta-conc-seller', '$copy'::uuid, 24, '$(rid)'::uuid)->>'success'")"
  [[ "$result" == "true" ]] || fail "auction setup failed for $copy: $result"
done
readonly A1="$(auction_id_of "$M1")"
readonly A2="$(auction_id_of "$M2")"
readonly A3="$(auction_id_of "$M3")"
readonly A4="$(auction_id_of "$M4")"
readonly A5="$(auction_id_of "$M5")"
readonly A6="$(auction_id_of "$M6")"
readonly A7="$(auction_id_of "$M7")"
readonly A8="$(auction_id_of "$M8")"


# ---------------------------------------------------------------------------
# S1 入札 × 通常出品(トリガー)
# ---------------------------------------------------------------------------
R1="$(rid)"
PGAPPNAME=s1-first "${PSQL[@]}" >"$TMP_DIR/s1-first" <<SQL &
BEGIN;
SELECT public.place_trade_auction_bid('ta-conc-bidder1', '$A1'::uuid, '$COIN_CARD_ID'::uuid, 1::smallint, '$R1'::uuid)->>'success';
SELECT pg_sleep(1.5);
COMMIT;
SQL
FIRST_PID=$!
wait_until "$(sleeping s1-first)"
"${PSQL[@]}" >"$TMP_DIR/s1-second" <<SQL
DO \$\$
BEGIN
  INSERT INTO public.trade_offers (
    offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
    wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
  ) VALUES (
    '$BIDDER1_ID', '$K1', '$COIN_CARD_ID', '$STREAMER_ID', '$GEM_CARD_ID', '$STREAMER_ID',
    '{"name": "Conc Coin", "rarity": "common", "imageUrl": null}'::jsonb,
    '{"name": "Conc Gem", "rarity": "epic", "imageUrl": null}'::jsonb
  );
  RAISE EXCEPTION 'S1_UNEXPECTED_SUCCESS';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'TRADE_CARD_LOCKED' THEN
    RAISE;
  END IF;
END
\$\$;
SQL
wait "$FIRST_PID"
[[ "$(head -1 "$TMP_DIR/s1-first")" == "true" ]] || fail "S1 bid failed: $(cat "$TMP_DIR/s1-first")"
S1_STATE="$("${PSQL[@]}" -c "
  SELECT (SELECT count(*) FROM public.trade_offers WHERE offered_user_card_id = '$K1' AND status = 'open')
    || '|' || (SELECT string_agg(i.user_card_id::text, ',') FROM public.trade_auction_bid_items i
               JOIN public.trade_auction_bids b ON b.id = i.bid_id
               WHERE b.auction_id = '$A1' AND b.status = 'active')")"
[[ "$S1_STATE" == "0|$K1" ]] || fail "S1 unexpected state: $S1_STATE"

# ---------------------------------------------------------------------------
# S2 通常出品 × 入札(出品が先に commit。bidder1 の残りの coin は K2 だけ)
# ---------------------------------------------------------------------------
PGAPPNAME=s2-first "${PSQL[@]}" >"$TMP_DIR/s2-first" <<SQL &
BEGIN;
INSERT INTO public.trade_offers (
  offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '$BIDDER1_ID', '$K2', '$COIN_CARD_ID', '$STREAMER_ID', '$GEM_CARD_ID', '$STREAMER_ID',
  '{"name": "Conc Coin", "rarity": "common", "imageUrl": null}'::jsonb,
  '{"name": "Conc Gem", "rarity": "epic", "imageUrl": null}'::jsonb
);
SELECT pg_sleep(1.5);
COMMIT;
SQL
FIRST_PID=$!
wait_until "$(sleeping s2-first)"
S2_RESULT="$("${PSQL[@]}" -c "SELECT public.place_trade_auction_bid('ta-conc-bidder1', '$A2'::uuid, '$COIN_CARD_ID'::uuid, 1::smallint, '$(rid)'::uuid)->>'error'")"
wait "$FIRST_PID"
[[ "$S2_RESULT" == "NOT_ENOUGH_CARDS" ]] || fail "S2 expected NOT_ENOUGH_CARDS, got $S2_RESULT"

# ---------------------------------------------------------------------------
# S3 入札 × 応諾の支払い(bidder2 の coin は K3 の1枚だけ)
# ---------------------------------------------------------------------------
R3="$(rid)"
PGAPPNAME=s3-first "${PSQL[@]}" >"$TMP_DIR/s3-first" <<SQL &
BEGIN;
SELECT public.place_trade_auction_bid('ta-conc-bidder2', '$A2'::uuid, '$COIN_CARD_ID'::uuid, 1::smallint, '$R3'::uuid)->>'success';
SELECT pg_sleep(1.5);
COMMIT;
SQL
FIRST_PID=$!
wait_until "$(sleeping s3-first)"
S3_RESULT="$("${PSQL[@]}" -c "SELECT public.accept_trade_offer('ta-conc-bidder2', '$OFFER_ID'::uuid, '$(rid)'::uuid, 1::smallint)->>'error'")"
wait "$FIRST_PID"
[[ "$(head -1 "$TMP_DIR/s3-first")" == "true" ]] || fail "S3 bid failed: $(cat "$TMP_DIR/s3-first")"
[[ "$S3_RESULT" == "CARD_NOT_OWNED" ]] || fail "S3 expected CARD_NOT_OWNED, got $S3_RESULT"
S3_STATE="$("${PSQL[@]}" -c "
  SELECT (SELECT user_id::text FROM public.user_cards WHERE id = '$K3')
    || '|' || (SELECT user_id::text FROM public.user_cards WHERE id = '$G2')
    || '|' || (SELECT status FROM public.trade_offers WHERE id = '$OFFER_ID')")"
[[ "$S3_STATE" == "$BIDDER2_ID|$OFFERER_ID|open" ]] || fail "S3 unexpected state: $S3_STATE"

# ---------------------------------------------------------------------------
# S4 入札変更 × 成立(期限境界)
#   接続1(入札変更)は締切前にオークション行のロックを取り、締切後まで持つ。
#   成立はそのロックを待ち、取得後の clock_timestamp() で判定する。
# ---------------------------------------------------------------------------
OLD_BID="$("${PSQL[@]}" -c "SELECT (public.place_trade_auction_bid('ta-conc-bidder3', '$A3'::uuid, '$COIN_CARD_ID'::uuid, 1::smallint, '$(rid)'::uuid)->'bid'->>'id')")"
[[ -n "$OLD_BID" ]] || fail "S4 setup bid failed"
R4="$(rid)"
"${PSQL[@]}" -c "UPDATE public.trade_auctions SET ends_at = clock_timestamp() + interval '1 second', selection_deadline = clock_timestamp() + interval '1 hour' WHERE id = '$A3'" >/dev/null
PGAPPNAME=s4-first "${PSQL[@]}" >"$TMP_DIR/s4-first" <<SQL &
BEGIN;
SELECT public.place_trade_auction_bid('ta-conc-bidder3', '$A3'::uuid, '$COIN_CARD_ID'::uuid, 2::smallint, '$R4'::uuid)->>'success';
SELECT pg_sleep(2.5);
COMMIT;
SQL
FIRST_PID=$!
wait_until "$(sleeping s4-first)"
S4_RESULT="$("${PSQL[@]}" -c "SELECT public.settle_trade_auction('ta-conc-seller', '$A3'::uuid, '$OLD_BID'::uuid, '$(rid)'::uuid)->>'error'")"
wait "$FIRST_PID"
[[ "$(head -1 "$TMP_DIR/s4-first")" == "true" ]] || fail "S4 bid change failed: $(cat "$TMP_DIR/s4-first")"
[[ "$S4_RESULT" == "BID_NOT_ACTIVE" ]] || fail "S4 expected BID_NOT_ACTIVE (time judged after the lock), got $S4_RESULT"
S4_STATE="$("${PSQL[@]}" -c "
  SELECT (SELECT status FROM public.trade_auctions WHERE id = '$A3')
    || '|' || (SELECT quantity::text FROM public.trade_auction_bids WHERE auction_id = '$A3' AND status = 'active')")"
[[ "$S4_STATE" == "open|2" ]] || fail "S4 unexpected state: $S4_STATE"

# ---------------------------------------------------------------------------
# S5 入札 × 入札期限
# ---------------------------------------------------------------------------
R5="$(rid)"
"${PSQL[@]}" -c "UPDATE public.trade_auctions SET ends_at = clock_timestamp() + interval '1 second' WHERE id = '$A4'" >/dev/null
PGAPPNAME=s5-holder "${PSQL[@]}" >"$TMP_DIR/s5-first" <<SQL &
BEGIN;
SELECT 1 FROM public.trade_auctions WHERE id = '$A4' FOR UPDATE;
SELECT pg_sleep(2.5);
COMMIT;
SQL
FIRST_PID=$!
wait_until "$(sleeping s5-holder)"
S5_RESULT="$("${PSQL[@]}" -c "SELECT public.place_trade_auction_bid('ta-conc-bidder1', '$A4'::uuid, '$GEM_CARD_ID'::uuid, 1::smallint, '$R5'::uuid)->>'error'")"
wait "$FIRST_PID"
[[ "$S5_RESULT" == "AUCTION_NOT_OPEN" ]] || fail "S5 expected AUCTION_NOT_OPEN, got $S5_RESULT"

# ---------------------------------------------------------------------------
# S6 成立 × 選択期限
# ---------------------------------------------------------------------------
S6_BID="$("${PSQL[@]}" -c "SELECT (public.place_trade_auction_bid('ta-conc-bidder1', '$A5'::uuid, '$GEM_CARD_ID'::uuid, 1::smallint, '$(rid)'::uuid)->'bid'->>'id')")"
[[ -n "$S6_BID" ]] || fail "S6 setup bid failed"
R6="$(rid)"
"${PSQL[@]}" -c "UPDATE public.trade_auctions SET ends_at = clock_timestamp() - interval '1 hour', selection_deadline = clock_timestamp() + interval '1 second' WHERE id = '$A5'" >/dev/null
PGAPPNAME=s6-holder "${PSQL[@]}" >"$TMP_DIR/s6-first" <<SQL &
BEGIN;
SELECT 1 FROM public.trade_auctions WHERE id = '$A5' FOR UPDATE;
SELECT pg_sleep(2.5);
COMMIT;
SQL
FIRST_PID=$!
wait_until "$(sleeping s6-holder)"
S6_RESULT="$("${PSQL[@]}" -c "SELECT public.settle_trade_auction('ta-conc-seller', '$A5'::uuid, '$S6_BID'::uuid, '$R6'::uuid)->>'error'")"
wait "$FIRST_PID"
[[ "$S6_RESULT" == "AUCTION_EXPIRED" ]] || fail "S6 expected AUCTION_EXPIRED, got $S6_RESULT"
S6_STATE="$("${PSQL[@]}" -c "
  SELECT (SELECT user_id::text FROM public.user_cards WHERE id = '$M5')
    || '|' || (SELECT user_id::text FROM public.user_cards WHERE id = '$G1')")"
[[ "$S6_STATE" == "$SELLER_ID|$BIDDER1_ID" ]] || fail "S6 unexpected state: $S6_STATE"

# ---------------------------------------------------------------------------
# S7 入札 × 出品コピーの通常出品(入札期限をまたぐ。PR #1850 レビュー必須 M1(a))
#   入札0件のオークション A8 に、締切前に始めた入札(接続1)が締切後に commit する。
#   その間(締切後)に出品者が同じ出品コピー M8 を通常出品する。入札が出品コピーの行を
#   ロックしないと、トリガーは待たずに「入札0件で締切済み = 拘束なし」と判定して
#   INSERT を通し、open な通常出品と選択待ちのオークションが同じコピーを二重に拘束する。
#   修正後は入札が M8 をロックしているので、トリガーは commit を待ってから判定し、
#   選択待ち(有効入札あり)の拘束を見て TRADE_CARD_LOCKED で拒否する。
# ---------------------------------------------------------------------------
R7="$(rid)"
"${PSQL[@]}" -c "UPDATE public.trade_auctions SET ends_at = clock_timestamp() + interval '1 second' WHERE id = '$A8'" >/dev/null
PGAPPNAME=s7-first "${PSQL[@]}" >"$TMP_DIR/s7-first" <<SQL &
BEGIN;
SELECT public.place_trade_auction_bid('ta-conc-bidder4', '$A8'::uuid, '$COIN_CARD_ID'::uuid, 1::smallint, '$R7'::uuid)->>'success';
SELECT pg_sleep(3);
COMMIT;
SQL
FIRST_PID=$!
wait_until "$(sleeping s7-first)"
wait_until "clock_timestamp() > (SELECT ends_at FROM public.trade_auctions WHERE id = '$A8')"
S7_OUT="$("${PSQL[@]}" 2>&1 <<SQL || true
INSERT INTO public.trade_offers (
  offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
) VALUES (
  '$SELLER_ID', '$M8', '$MAIN_CARD_ID', '$STREAMER_ID', '$GEM_CARD_ID', '$STREAMER_ID',
  '{"name": "Conc Main", "rarity": "rare", "imageUrl": null}'::jsonb,
  '{"name": "Conc Gem", "rarity": "epic", "imageUrl": null}'::jsonb
);
SQL
)"
wait "$FIRST_PID"
[[ "$(head -1 "$TMP_DIR/s7-first")" == "true" ]] || fail "S7 bid failed: $(cat "$TMP_DIR/s7-first")"
S7_STATE="$("${PSQL[@]}" -c "
  SELECT (SELECT count(*) FROM public.trade_offers WHERE offered_user_card_id = '$M8' AND status = 'open')
    || '|' || public.trade_copy_auction_locked('$M8'::uuid)::text")"
[[ "$S7_OUT" == *TRADE_CARD_LOCKED* && "$S7_STATE" == "0|true" ]] \
  || fail "S7 the listed copy was double-locked across the deadline (insert: ${S7_OUT:-accepted}, open offers|auction lock: $S7_STATE)"

# ---------------------------------------------------------------------------
# S8 成立 × 選択期限 × 別オークションへの入札(PR #1850 レビュー必須 M1(b))
#   A6 の選択期限前に成立を始める。成立は時刻判定を通過した後、出品コピー M6 の
#   行ロックを待つ(接続0 が M6 を持っている)。待っている間に選択期限が過ぎて A6 は
#   流札になり、同じ入札コピー K8 で別オークション A7 への入札が成功する。成立が
#   ロック取得後に時刻を再判定しないと、K8 を出品者へ移し、A7 の有効入札が他人の
#   コピーを拘束したまま残る。修正後は、全コピーのロック取得後に selection_deadline を
#   再判定して AUCTION_EXPIRED を返し、何も移さない。
# ---------------------------------------------------------------------------
S8_BID="$("${PSQL[@]}" -c "SELECT (public.place_trade_auction_bid('ta-conc-bidder5', '$A6'::uuid, '$COIN_CARD_ID'::uuid, 1::smallint, '$(rid)'::uuid)->'bid'->>'id')")"
[[ -n "$S8_BID" ]] || fail "S8 setup bid failed"
R8_SETTLE="$(rid)"
R8_BID="$(rid)"
"${PSQL[@]}" -c "UPDATE public.trade_auctions SET ends_at = clock_timestamp() - interval '1 hour', selection_deadline = clock_timestamp() + interval '1.5 seconds' WHERE id = '$A6'" >/dev/null
PGAPPNAME=s8-holder "${PSQL[@]}" >"$TMP_DIR/s8-holder" <<SQL &
BEGIN;
SELECT 1 FROM public.user_cards WHERE id = '$M6' FOR UPDATE;
SELECT pg_sleep(4);
COMMIT;
SQL
HOLDER_PID=$!
wait_until "$(sleeping s8-holder)"
PGAPPNAME=s8-settle "${PSQL[@]}" >"$TMP_DIR/s8-settle" <<SQL &
SELECT coalesce(public.settle_trade_auction('ta-conc-seller', '$A6'::uuid, '$S8_BID'::uuid, '$R8_SETTLE'::uuid)->>'error', 'SUCCESS');
SQL
SETTLE_PID=$!
# 成立が時刻判定を通過してコピーの行ロックを待っていること(期限前に始まったこと)を確かめる。
wait_until "$(blocked s8-settle)"
wait_until "clock_timestamp() > (SELECT selection_deadline FROM public.trade_auctions WHERE id = '$A6')"
S8_BID_RESULT="$("${PSQL[@]}" -c "SELECT public.place_trade_auction_bid('ta-conc-bidder5', '$A7'::uuid, '$COIN_CARD_ID'::uuid, 1::smallint, '$R8_BID'::uuid)->>'success'")"
wait "$HOLDER_PID"
wait "$SETTLE_PID"
S8_SETTLE="$(cat "$TMP_DIR/s8-settle")"
[[ "$S8_BID_RESULT" == "true" ]] || fail "S8 bid on the other auction after the deadline failed: $S8_BID_RESULT"
S8_STATE="$("${PSQL[@]}" -c "
  SELECT (SELECT user_id::text FROM public.user_cards WHERE id = '$K8')
    || '|' || (SELECT user_id::text FROM public.user_cards WHERE id = '$M6')")"
[[ "$S8_SETTLE" == "AUCTION_EXPIRED" && "$S8_STATE" == "$BIDDER5_ID|$SELLER_ID" ]] \
  || fail "S8 settle moved a copy taken by another bid after the deadline (settle: $S8_SETTLE, owners K8|M6: $S8_STATE)"

echo "trade-auction concurrency checks passed"
