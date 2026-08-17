#!/usr/bin/env bash
set -euo pipefail

# Issue #722 (#715 子2): PRレビューで発見された資産複製/窃取バグ(2026-08-17,
# Claude Auto Review指摘・修正済み)の再発防止テスト。
#
# 同一応諾者(acceptor)が、同じ支払いカード種別(wanted)を要求する2件の
# オファーを同時にacceptすると、修正前は応諾者の支払いカード選択に行ロックが
# 無かったため、acceptorが1枚のカードで2件の交換を成立させてしまい、出品者の
# 一方がカードだけ失って何も得られない状態になり得た。
# accept_trade_offer内のコメント(238-297行目付近)が示すとおり、支払いカード
# 候補の選定SELECTは意図的にFOR UPDATEを付けていない(LIMIT 1 + FOR UPDATEが
# 「対象行がロック待ち中に条件を外れても繰り上がらない」問題を避けるため)。
# そのため2接続が同一の未ロック行を選定しうる競合は、実際の所有権移転UPDATEに
# user_id条件付き・GET DIAGNOSTICS行数チェックを付けることで最終防御している。
# この直列化はUPDATE文自体の行ロックに依存するため、単一SQLトランザクションの
# fixtureでは接続間競合を再現できず、2接続からの同時accept_trade_offer呼び出しでしか
# 検証できない。

readonly DB_HOST="${PGHOST:-127.0.0.1}"
readonly DB_PORT="${PGPORT:-5432}"
readonly DB_USER="${PGUSER:-postgres}"
readonly DB_NAME="${PGDATABASE:-postgres}"
readonly PSQL=(psql -X -qAt -v ON_ERROR_STOP=1 \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME")

readonly STREAMER_ID='31000000-0000-4100-8100-000000000001'
readonly OFFERER1_ID='31000000-0000-4100-8100-0000000000a1'
readonly OFFERER2_ID='31000000-0000-4100-8100-0000000000a2'
readonly ACCEPTOR_ID='31000000-0000-4100-8100-0000000000a3'
readonly OFFERED1_CARD_ID='31000000-0000-4100-8100-0000000000c1'
readonly OFFERED2_CARD_ID='31000000-0000-4100-8100-0000000000c2'
readonly WANTED_CARD_ID='31000000-0000-4100-8100-0000000000c3'
readonly OFFERED1_USER_CARD_ID='31000000-0000-4100-8100-0000000000d1'
readonly OFFERED2_USER_CARD_ID='31000000-0000-4100-8100-0000000000d2'
readonly WANTED_USER_CARD_ID='31000000-0000-4100-8100-0000000000d3'
readonly OFFER1_ID='31000000-0000-4100-8100-0000000000e1'
readonly OFFER2_ID='31000000-0000-4100-8100-0000000000e2'
readonly REQUEST1_ID='31000000-0000-4100-8100-0000000000f1'
readonly REQUEST2_ID='31000000-0000-4100-8100-0000000000f2'

FIRST_OUTPUT="$(mktemp)"
SECOND_OUTPUT="$(mktemp)"
STATE_OUTPUT="$(mktemp)"
cleanup() {
  rm -f "$FIRST_OUTPUT" "$SECOND_OUTPUT" "$STATE_OUTPUT"
}
trap cleanup EXIT

# Setup(1回だけ)。streamer 1件、offerer 2名、acceptor 1名、offered用カード
# 2種、wanted用カード1種。acceptorはwantedを1枚だけ持ち、offer1/offer2の
# どちらも同じこの1枚を要求する点がこのシナリオの核心。
"${PSQL[@]}" -1 <<SQL
INSERT INTO public.streamers (
  id, twitch_user_id, twitch_username, twitch_display_name,
  trade_enabled, cross_channel_trade_enabled
) VALUES (
  '$STREAMER_ID',
  'trade-conc-streamer', 'trade-conc-streamer', 'Trade Concurrency Streamer',
  true, true
);

INSERT INTO public.users (id, twitch_user_id, twitch_username, twitch_display_name)
VALUES
  ('$OFFERER1_ID', 'trade-conc-offerer1', 'trade-conc-offerer1', 'Trade Conc Offerer1'),
  ('$OFFERER2_ID', 'trade-conc-offerer2', 'trade-conc-offerer2', 'Trade Conc Offerer2'),
  ('$ACCEPTOR_ID', 'trade-conc-acceptor', 'trade-conc-acceptor', 'Trade Conc Acceptor');

INSERT INTO public.cards (id, streamer_id, name, rarity, drop_rate, is_active)
VALUES
  ('$OFFERED1_CARD_ID', '$STREAMER_ID', 'Concurrency Offered One', 'common', 0.34, true),
  ('$OFFERED2_CARD_ID', '$STREAMER_ID', 'Concurrency Offered Two', 'rare', 0.33, true),
  ('$WANTED_CARD_ID', '$STREAMER_ID', 'Concurrency Wanted', 'epic', 0.33, true);

INSERT INTO public.user_cards (id, user_id, card_id)
VALUES
  ('$OFFERED1_USER_CARD_ID', '$OFFERER1_ID', '$OFFERED1_CARD_ID'),
  ('$OFFERED2_USER_CARD_ID', '$OFFERER2_ID', '$OFFERED2_CARD_ID'),
  ('$WANTED_USER_CARD_ID', '$ACCEPTOR_ID', '$WANTED_CARD_ID');

INSERT INTO public.trade_offers (
  id, offerer_user_id, offered_user_card_id, offered_card_id, offered_streamer_id,
  wanted_card_id, wanted_streamer_id, offered_card_snapshot, wanted_card_snapshot
) VALUES
  (
    '$OFFER1_ID', '$OFFERER1_ID', '$OFFERED1_USER_CARD_ID', '$OFFERED1_CARD_ID', '$STREAMER_ID',
    '$WANTED_CARD_ID', '$STREAMER_ID',
    '{"name": "Concurrency Offered One", "rarity": "common", "imageUrl": null}'::jsonb,
    '{"name": "Concurrency Wanted", "rarity": "epic", "imageUrl": null}'::jsonb
  ),
  (
    '$OFFER2_ID', '$OFFERER2_ID', '$OFFERED2_USER_CARD_ID', '$OFFERED2_CARD_ID', '$STREAMER_ID',
    '$WANTED_CARD_ID', '$STREAMER_ID',
    '{"name": "Concurrency Offered Two", "rarity": "rare", "imageUrl": null}'::jsonb,
    '{"name": "Concurrency Wanted", "rarity": "epic", "imageUrl": null}'::jsonb
  );
SQL

# 2つのオファーを同一acceptorから同時にacceptする。行ロックが自然に直列化
# するため、事前のholdや advisory lock ポーリングは不要(単純な同時発火で
# 決定的に再現できることを主担当が手動確認済み)。
"${PSQL[@]}" >"$FIRST_OUTPUT" <<SQL &
SELECT public.accept_trade_offer('trade-conc-acceptor', '$OFFER1_ID'::uuid, '$REQUEST1_ID'::uuid);
SQL
FIRST_PID=$!

"${PSQL[@]}" >"$SECOND_OUTPUT" <<SQL &
SELECT public.accept_trade_offer('trade-conc-acceptor', '$OFFER2_ID'::uuid, '$REQUEST2_ID'::uuid);
SQL
SECOND_PID=$!

wait "$FIRST_PID"
wait "$SECOND_PID"

FIRST_RESULT="$(cat "$FIRST_OUTPUT")"
SECOND_RESULT="$(cat "$SECOND_OUTPUT")"

# ちょうど1つがsuccess:true、ちょうど1つがCARD_NOT_OWNEDであること。
# どちらが勝つかは非決定的でよいため、順序に依存しないチェックにする。
SUCCESS_COUNT=0
FAILURE_COUNT=0
for result in "$FIRST_RESULT" "$SECOND_RESULT"; do
  if [[ "$result" == *'"success": true'* ]]; then
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
  elif [[ "$result" == *'"success": false'* && "$result" == *'"error": "CARD_NOT_OWNED"'* ]]; then
    FAILURE_COUNT=$((FAILURE_COUNT + 1))
  else
    echo "unexpected accept_trade_offer result: $result" >&2
    exit 1
  fi
done
if [[ "$SUCCESS_COUNT" -ne 1 || "$FAILURE_COUNT" -ne 1 ]]; then
  echo "expected exactly one success and one CARD_NOT_OWNED failure, got success=$SUCCESS_COUNT failure=$FAILURE_COUNT" >&2
  echo "first: $FIRST_RESULT" >&2
  echo "second: $SECOND_RESULT" >&2
  exit 1
fi

# DB状態そのものからも、成立/失敗の副作用が仕様どおりであることを検証する
# (RPCの戻り値だけでなく、実際にコミットされた状態を突き合わせる)。
"${PSQL[@]}" <<SQL >"$STATE_OUTPUT"
SELECT
  coalesce((SELECT status FROM public.trade_offers WHERE id = '$OFFER1_ID'), 'NULL') || '|' ||
  coalesce((SELECT status FROM public.trade_offers WHERE id = '$OFFER2_ID'), 'NULL') || '|' ||
  coalesce((SELECT accepted_by_user_id::text FROM public.trade_offers WHERE id = '$OFFER1_ID'), 'NULL') || '|' ||
  coalesce((SELECT accepted_by_user_id::text FROM public.trade_offers WHERE id = '$OFFER2_ID'), 'NULL') || '|' ||
  coalesce((SELECT user_id::text FROM public.user_cards WHERE id = '$OFFERED1_USER_CARD_ID'), 'NULL') || '|' ||
  coalesce((SELECT user_id::text FROM public.user_cards WHERE id = '$OFFERED2_USER_CARD_ID'), 'NULL') || '|' ||
  coalesce((SELECT user_id::text FROM public.user_cards WHERE id = '$WANTED_USER_CARD_ID'), 'NULL');
SQL
STATE="$(cat "$STATE_OUTPUT")"
IFS='|' read -r O1_STATUS O2_STATUS O1_ACCEPTED_BY O2_ACCEPTED_BY D1_OWNER D2_OWNER D3_OWNER <<<"$STATE"

if [[ "$O1_STATUS" == "completed" && "$O2_STATUS" == "open" ]]; then
  WINNER_OFFERER="$OFFERER1_ID"
  LOSER_OFFER_ACCEPTED_BY="$O2_ACCEPTED_BY"
  LOSER_CARD_OWNER="$D2_OWNER"
  LOSER_CARD_EXPECTED_OWNER="$OFFERER2_ID"
elif [[ "$O2_STATUS" == "completed" && "$O1_STATUS" == "open" ]]; then
  WINNER_OFFERER="$OFFERER2_ID"
  LOSER_OFFER_ACCEPTED_BY="$O1_ACCEPTED_BY"
  LOSER_CARD_OWNER="$D1_OWNER"
  LOSER_CARD_EXPECTED_OWNER="$OFFERER1_ID"
else
  echo "expected exactly one offer to complete and the other to remain open, got offer1=$O1_STATUS offer2=$O2_STATUS" >&2
  exit 1
fi

if [[ "$LOSER_OFFER_ACCEPTED_BY" != "NULL" ]]; then
  echo "the offer that failed with CARD_NOT_OWNED unexpectedly recorded an acceptor: $LOSER_OFFER_ACCEPTED_BY" >&2
  exit 1
fi

# 核心の回帰チェック: 失敗した側の出品者のカードが移転していないこと。
# 修正前バグでは、支払いカードの奪い合いに負けた側でも出品カードだけ先に
# 移転してしまっていた。
if [[ "$LOSER_CARD_OWNER" != "$LOSER_CARD_EXPECTED_OWNER" ]]; then
  echo "the losing offerer's own card moved despite the trade failing (owner=$LOSER_CARD_OWNER expected=$LOSER_CARD_EXPECTED_OWNER)" >&2
  exit 1
fi

# acceptorの支払いカード(wanted、1枚のみ)は、成立した側の出品者にのみ
# 渡っていること(二重譲渡が起きていないこと)。
if [[ "$D3_OWNER" != "$WINNER_OFFERER" ]]; then
  echo "the single paid card was not transferred to exactly the winning offerer (owner=$D3_OWNER expected=$WINNER_OFFERER)" >&2
  exit 1
fi

echo "add-card-trading concurrency checks passed"
