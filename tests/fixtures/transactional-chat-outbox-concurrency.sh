#!/usr/bin/env bash
set -euo pipefail

# Issue #803: 同一EventSubをlive処理とCron replayが別接続で同時実行しても、
# 発行上限より先にduplicateとして直列化されることをPostgreSQL 17で検証する。
# 単一SQL transactionのfixtureでは接続間競合を再現できないため、先行RPCを
# COMMIT前で保持し、後続RPCを意図的に競合させる。

readonly DB_HOST="${PGHOST:-127.0.0.1}"
readonly DB_PORT="${PGPORT:-5432}"
readonly DB_USER="${PGUSER:-postgres}"
readonly DB_NAME="${PGDATABASE:-postgres}"
readonly PSQL=(psql -X -qAt -v ON_ERROR_STOP=1 \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME")

FIRST_OUTPUT="$(mktemp)"
SECOND_OUTPUT="$(mktemp)"
FIRST_ERROR="$(mktemp)"
cleanup() {
  rm -f "$FIRST_OUTPUT" "$SECOND_OUTPUT" "$FIRST_ERROR"
}
trap cleanup EXIT

"${PSQL[@]}" -1 <<'SQL'
INSERT INTO public.streamers (
  id, twitch_user_id, twitch_username, twitch_display_name,
  chat_announcement_enabled
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'concurrency-streamer',
  'concurrency-streamer',
  'Concurrency Streamer',
  true
);

INSERT INTO public.cards (
  id, streamer_id, name, rarity, drop_rate, is_active, max_issuance_count
) VALUES
  (
    '55555555-5555-4555-8555-555555555555',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'Same Card', 'common', 0.34, true, 1
  ),
  (
    '66666666-6666-4666-8666-666666666666',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'First Different Card', 'rare', 0.33, true, 1
  ),
  (
    '77777777-7777-4777-8777-777777777777',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'Second Different Card', 'epic', 0.33, true, 1
  );
SQL

run_concurrent_case() {
  local event_id="$1"
  local viewer_id="$2"
  local first_card_id="$3"
  local second_card_id="$4"

  : >"$FIRST_OUTPUT"
  : >"$SECOND_OUTPUT"
  : >"$FIRST_ERROR"

  # 先行接続はRPCの副作用を作った後も2秒COMMITせず保持する。後続接続の
  # 冒頭SELECTからは未commit履歴が見えない状態を決定的に作る。
  "${PSQL[@]}" >"$FIRST_OUTPUT" 2>"$FIRST_ERROR" <<SQL &
BEGIN;
SELECT concat(
  result ->> 'is_duplicate',
  '|',
  coalesce(result ->> 'limit_reached', 'null')
)
FROM (
  SELECT public.execute_gacha_transaction_with_chat_outbox(
    '$event_id',
    '$viewer_id',
    'Concurrency Viewer',
    '$first_card_id'::uuid,
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
    100,
    'concurrency-reward',
    '$event_id',
    1,
    1,
    NULL
  ) AS result
) AS first_call;
SELECT pg_sleep(2);
COMMIT;
SQL
  local first_pid=$!

  # 別接続のtry-lockで、先行RPCがevent advisory lockを実際に保持したことを
  # 確認する。stdoutのflush時期や固定sleepに依存せず、未commit競合を決定的に作る。
  local ready=0
  for _ in $(seq 1 50); do
    local lock_held
    lock_held="$("${PSQL[@]}" -c "
      SELECT NOT pg_try_advisory_lock(hashtextextended('$event_id', 803));
    ")"
    # try-lockがtrueだったpoll接続はそのクライアント終了時に自動解放される。
    # false（NOT後はtrue）なら先行接続が所有中で、後続を開始してよい。
    if [[ "$lock_held" == 't' ]]; then
      ready=1
      break
    fi
    if ! kill -0 "$first_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if [[ "$ready" -ne 1 ]]; then
    wait "$first_pid" || true
    echo "first concurrent RPC did not reach the pre-commit hold" >&2
    sed -n '1,120p' "$FIRST_ERROR" >&2
    return 1
  fi

  "${PSQL[@]}" >"$SECOND_OUTPUT" <<SQL
SELECT concat(
  result ->> 'is_duplicate',
  '|',
  coalesce(result ->> 'limit_reached', 'null')
)
FROM (
  SELECT public.execute_gacha_transaction_with_chat_outbox(
    '$event_id',
    '$viewer_id',
    'Concurrency Viewer',
    '$second_card_id'::uuid,
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
    100,
    'concurrency-reward',
    '$event_id',
    1,
    1,
    NULL
  ) AS result
) AS second_call;
SQL
  wait "$first_pid"

  grep -q '^false|false$' "$FIRST_OUTPUT"
  grep -q '^true|null$' "$SECOND_OUTPUT"

  # 先行だけがカードを付与し、後続は同一/別cardのどちらを選んでもduplicate。
  # limit_reachedによる誤返金を許さず、履歴・所有・outboxも各1件へ収束する。
  local counts
  counts="$("${PSQL[@]}" <<SQL
SELECT concat(
  (SELECT count(*) FROM public.gacha_history WHERE event_id = '$event_id'),
  '|',
  (
    SELECT count(*)
    FROM public.user_cards uc
    JOIN public.users u ON u.id = uc.user_id
    WHERE u.twitch_user_id = '$viewer_id'
  ),
  '|',
  (SELECT count(*) FROM public.chat_notification_outbox WHERE batch_id = '$event_id')
);
SQL
)"
  if [[ "$counts" != '1|1|1' ]]; then
    echo "concurrent RPC invariant failed for $event_id: $counts" >&2
    return 1
  fi
}

run_concurrent_case \
  'concurrent-same-event' \
  'concurrent-same-viewer' \
  '55555555-5555-4555-8555-555555555555' \
  '55555555-5555-4555-8555-555555555555'

run_concurrent_case \
  'concurrent-different-event' \
  'concurrent-different-viewer' \
  '66666666-6666-4666-8666-666666666666' \
  '77777777-7777-4777-8777-777777777777'

echo "transactional chat outbox concurrency checks passed"
