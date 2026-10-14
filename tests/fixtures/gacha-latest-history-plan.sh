#!/usr/bin/env bash
set -euo pipefail

# Issue #1300: getLatestCardIdForStreamer(ガチャ直近履歴クエリ)の実DB検証。
#
# SQL文字列テストやvitestのモックではexecution planが検証できない。「履歴件数に
# 対して安定したプランになっているか」はPostgreSQLのplannerが統計情報と
# visibility mapを見て決めるため、実PostgreSQL 17へpreview相当データ量を投入
# して確かめる必要がある(analysis-dashboard-pagination-postgres.sql と同じ発想)。
#
# 背景: `ORDER BY redeemed_at DESC, id DESC` のままでは、plannerが
# idx_gacha_history_redeemed_at_analysis(redeemed_at単独)を選び、streamer_idを
# ヒープ側Filterとして評価する。そうすると「自分より新しい全配信者の履歴」を
# 1行ずつFilterして落とすため、履歴が大きいほど線形に悪化する。このfixtureと同じ
# 40万件・直近履歴が古い配信者で、アプリと同じprepared statementとして200回実行した
# 実測(投入→VACUUM後):
#   - `ORDER BY redeemed_at DESC, id DESC` → 15.4 ms/call
#     (Incremental Sort + Rows Removed by Filter: 200,003)
#   - `ORDER BY redeemed_at DESC`          → 0.009 ms/call
#     (idx_gacha_history_streamer_redeemed_card_user の Index Only Scan Backward)
#
# なぜshell fixtureか:
#   - 実行計画の測定にはVACUUMが必要。VACUUMはtransaction内で実行できないため、
#     BEGIN/ROLLBACK形式のSQL fixtureでは、投入直後のdirty visibility mapのまま
#     計測してしまい(plannerがglobal indexを選び大幅に遅くなる)、本番(autovacuumが
#     回っている)と同じ条件を再現できない。ここでは投入→VACUUM→計測→後片付けを
#     コミット済みデータで行う(add-card-trading-concurrency.sh と同じ方式)。
#   - アプリはpostgres.jsのprepared statement(prepare: trueが既定、Hyperdriveも
#     キャッシュする)で投げるため、planは「5回目以降のgeneric plan」が本体。
#     リテラル直打ちのEXPLAINはcustom planになり別物の計測になるため、
#     PREPARE→EXECUTE(ウォームアップ)→EXPLAIN EXECUTEで実際に使われるplanを見る。
#
# 検証内容:
#   1) NULL履歴が最新でも、古いカードへ固定されず「最新の非NULL履歴」を返す
#   2) 履歴が全部NULLの配信者では0件(呼出側が独立抽選へフォールバックする)
#   3) 「直近が古く、自分より新しい大量の行が後ろに積まれている」形状と
#      「履歴が数件だけ」の形状の両方で、最新1件取得がcovering index
#      (idx_gacha_history_streamer_redeemed_card_user)を使い、Sortを挟まず、
#      まとまった行数をFilterしていない

readonly DB_HOST="${PGHOST:-127.0.0.1}"
readonly DB_PORT="${PGPORT:-5432}"
readonly DB_USER="${PGUSER:-postgres}"
readonly DB_NAME="${PGDATABASE:-postgres}"
readonly PSQL=(psql -X -qAt -v ON_ERROR_STOP=1 \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME")

readonly STALE_STREAMER='13000000-0000-4000-8000-000000000001'
readonly ACTIVE_STREAMER='13000000-0000-4000-8000-000000000002'
readonly LIGHT_STREAMER='13000000-0000-4000-8000-000000000003'
readonly ALL_NULL_STREAMER='13000000-0000-4000-8000-000000000004'
readonly BULK_CARD='13000000-0000-4000-8000-0000000000c1'
readonly LATEST_CARD='13000000-0000-4000-8000-0000000000c2'
readonly NULL_HISTORY_CARD='13000000-0000-4000-8000-0000000000c3'

# 後片付け: 自分の投入分だけ落として、CI用DBを元の状態へ戻す。他fixtureが
# 残した行は消さない(後続fixtureの行数期待値を壊さないため)。
#
# 投入の途中で失敗すると trg_sync_channel_point_usage_stat がDISABLEのまま残る
# (ALTER TABLEはセッションをまたいで永続する)ため、後片付けでは必ずENABLEへ戻す。
# これが戻らないと後続fixtureの channel_point_usage_stats 検証が壊れる。
purge_fixture_rows() {
  "${PSQL[@]}" -c \
    "ALTER TABLE public.gacha_history ENABLE TRIGGER trg_sync_channel_point_usage_stat;" || true
  "${PSQL[@]}" <<SQL || true
ALTER TABLE public.gacha_history DISABLE TRIGGER trg_sync_channel_point_usage_stat;
DELETE FROM public.gacha_history
WHERE streamer_id IN (
  '$STALE_STREAMER', '$ACTIVE_STREAMER', '$LIGHT_STREAMER', '$ALL_NULL_STREAMER'
);
ALTER TABLE public.gacha_history ENABLE TRIGGER trg_sync_channel_point_usage_stat;
DELETE FROM public.streamers
WHERE id IN ('$STALE_STREAMER', '$ACTIVE_STREAMER', '$LIGHT_STREAMER', '$ALL_NULL_STREAMER');
SQL
}

cleanup() {
  purge_fixture_rows
  # 削除でvisibility mapが崩れるため、計測へ影響しないように立て直しておく。
  "${PSQL[@]}" -c "VACUUM (ANALYZE) public.gacha_history;" || true
  "${PSQL[@]}" -c "VACUUM (ANALYZE) public.streamers;" || true
}
trap cleanup EXIT

# 前回の実行が失敗してデータが残っていた場合に備えて、最初に自分の投入分を落とす。
purge_fixture_rows

# ---------------------------------------------------------------------------
# 投入(preview相当データ量)
# ---------------------------------------------------------------------------
# stale heavy: 履歴20万件・最終引き換えは2026-02-01。自分より新しい行が
#               大量に積まれた状態が #1300 の退行ケース。
# active heavy: 履歴20万件・直近30日(stale heavyより新しい行の本体)。
# light:        履歴3件(プレビュー初期の配信者)。
# all null:     履歴5件すべて redeemed_at = NULL。
"${PSQL[@]}" <<SQL
INSERT INTO public.streamers (id, twitch_user_id, twitch_username, twitch_display_name)
VALUES
  ('$STALE_STREAMER', 'ghp-streamer-stale', 'ghp-streamer-stale', 'GHP Stale Heavy'),
  ('$ACTIVE_STREAMER', 'ghp-streamer-active', 'ghp-streamer-active', 'GHP Active Heavy'),
  ('$LIGHT_STREAMER', 'ghp-streamer-light', 'ghp-streamer-light', 'GHP Light'),
  ('$ALL_NULL_STREAMER', 'ghp-streamer-allnull', 'ghp-streamer-allnull', 'GHP All NULL')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.cards (id, streamer_id, name, rarity, drop_rate, is_active)
VALUES
  ('$BULK_CARD', '$STALE_STREAMER', 'GHP Bulk Card', 'common', 0.5, true),
  ('$LATEST_CARD', '$STALE_STREAMER', 'GHP Latest Card', 'common', 0.5, true),
  ('$NULL_HISTORY_CARD', '$STALE_STREAMER', 'GHP NULL History Card', 'common', 0.5, true)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.gacha_history DISABLE TRIGGER trg_sync_channel_point_usage_stat;

INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id, redeemed_at, event_id
)
SELECT
  md5('ghp-stale-' || i)::UUID,
  'ghp-viewer-' || (i % 500),
  'ghp-viewer-' || (i % 500),
  '$BULK_CARD',
  '$STALE_STREAMER',
  TIMESTAMPTZ '2026-01-01T00:00:00Z' + (i * INTERVAL '13 second'),
  'ghp-stale-evt-' || i
FROM generate_series(1, 200000) AS series(i);

-- stale heavy の「最新の非NULL履歴」。これが最新履歴クエリの期待結果。
INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id, redeemed_at, event_id
) VALUES (
  '13000000-0000-4000-8000-0000000000a1',
  'ghp-viewer-latest', 'ghp-viewer-latest',
  '$LATEST_CARD',
  '$STALE_STREAMER',
  TIMESTAMPTZ '2026-02-01T00:00:00Z', 'ghp-stale-evt-latest'
);

-- stale heavy の最新10件は redeemed_at = NULL。PostgreSQLのDESCは既定で
-- NULLS FIRSTなので、IS NOT NULLが無いとこのNULL行が「最新」として拾われる。
-- カードを別物にして、フィルタが外れたら期待結果が崩れるようにする。
INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id, redeemed_at, event_id
)
SELECT
  md5('ghp-null-' || i)::UUID,
  'ghp-viewer-null-' || i,
  'ghp-viewer-null-' || i,
  '$NULL_HISTORY_CARD',
  '$STALE_STREAMER',
  NULL,
  'ghp-stale-evt-null-' || i
FROM generate_series(1, 10) AS series(i);

INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id, redeemed_at, event_id
)
SELECT
  md5('ghp-active-' || i)::UUID,
  'ghp-viewer-' || (i % 500),
  'ghp-viewer-' || (i % 500),
  '$BULK_CARD',
  '$ACTIVE_STREAMER',
  TIMESTAMPTZ '2026-10-01T00:00:00Z' + (i * INTERVAL '13 second'),
  'ghp-active-evt-' || i
FROM generate_series(1, 200000) AS series(i);

INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id, redeemed_at, event_id
)
SELECT
  md5('ghp-light-' || i)::UUID,
  'ghp-viewer-light-' || i,
  'ghp-viewer-light-' || i,
  '$BULK_CARD',
  '$LIGHT_STREAMER',
  TIMESTAMPTZ '2026-10-10T00:00:00Z' + (i * INTERVAL '1 hour'),
  'ghp-light-evt-' || i
FROM generate_series(1, 3) AS series(i);

INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id, redeemed_at, event_id
)
SELECT
  md5('ghp-allnull-' || i)::UUID,
  'ghp-viewer-allnull-' || i,
  'ghp-viewer-allnull-' || i,
  '$BULK_CARD',
  '$ALL_NULL_STREAMER',
  NULL,
  'ghp-allnull-evt-' || i
FROM generate_series(1, 5) AS series(i);

ALTER TABLE public.gacha_history ENABLE TRIGGER trg_sync_channel_point_usage_stat;
SQL

# 投入直後はvisibility mapが立っていないためplannerの見積もりが本番とずれる。
# autovacuumが回っている本番と同じ状態にしてから計測する。
"${PSQL[@]}" -c "VACUUM (ANALYZE) public.gacha_history;"
"${PSQL[@]}" -c "VACUUM (ANALYZE) public.streamers;"

# ---------------------------------------------------------------------------
# 1) / 2) 結果の正しさ(NULL耐性)
# ---------------------------------------------------------------------------
LATEST_CARD_RESULT="$("${PSQL[@]}" -c \
  "SELECT card_id FROM public.gacha_history
   WHERE streamer_id = '$STALE_STREAMER' AND redeemed_at IS NOT NULL
   ORDER BY redeemed_at DESC LIMIT 1;")"
if [[ "$LATEST_CARD_RESULT" != "$LATEST_CARD" ]]; then
  echo "NULL履歴が最新のとき、最新の非NULL履歴を返していない (got=$LATEST_CARD_RESULT expected=$LATEST_CARD)" >&2
  exit 1
fi

ALL_NULL_ROWS="$("${PSQL[@]}" -c \
  "SELECT count(*) FROM (
     SELECT card_id FROM public.gacha_history
     WHERE streamer_id = '$ALL_NULL_STREAMER' AND redeemed_at IS NOT NULL
     ORDER BY redeemed_at DESC LIMIT 1
   ) AS latest;")"
if [[ "$ALL_NULL_ROWS" != "0" ]]; then
  echo "履歴が全部NULLの配信者で0件になっていない (rows=$ALL_NULL_ROWS)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3) 実行計画: 直近履歴クエリがcovering indexを使い、Sortも大量Filterもない
#
#    PREPARE→EXECUTE(6回のウォームアップ)→EXPLAIN EXECUTE で、アプリが実際に
#    使う(prepared statementの)planを見る。リテラル直打ちのEXPLAINはcustom plan
#    になり、streamer_idの選択率しだいでglobal indexを選ぶ別物の計測になる。
# ---------------------------------------------------------------------------
assert_latest_plan() {
  local streamer_id="$1"
  local label="$2"
  local plan
  plan="$("${PSQL[@]}" <<SQL
PREPARE ghp_latest(uuid) AS
  SELECT card_id FROM gacha_history
  WHERE streamer_id = \$1 AND redeemed_at IS NOT NULL
  ORDER BY redeemed_at DESC LIMIT 1;
EXECUTE ghp_latest('$streamer_id');
EXECUTE ghp_latest('$streamer_id');
EXECUTE ghp_latest('$streamer_id');
EXECUTE ghp_latest('$streamer_id');
EXECUTE ghp_latest('$streamer_id');
EXECUTE ghp_latest('$streamer_id');
EXPLAIN (ANALYZE, BUFFERS) EXECUTE ghp_latest('$streamer_id');
SQL
)"

  if [[ "$plan" != *"idx_gacha_history_streamer_redeemed_card_user"* ]]; then
    echo "$label: ガチャ直近履歴クエリがcovering indexを使っていない" >&2
    echo "$plan" >&2
    exit 1
  fi

  # Incremental Sort も "Sort" に一致する。第2キー(id)が戻るとpresorted prefixが
  # 効かずSortが必要な計画になり、plannerがglobal indexへ寄る。
  if [[ "$plan" == *"Sort"* ]]; then
    echo "$label: ガチャ直近履歴クエリのプランにSortが残っている" >&2
    echo "$plan" >&2
    exit 1
  fi

  # 4桁以上の行数をFilterして落とす計画(=redeemed_at単独indexを後方から辿って
  # streamer_idをヒープ側で落とす形)は、履歴が多い配信者で線形に悪化する。
  if [[ "$plan" =~ Rows\ Removed\ by\ Filter:\ [0-9]{4,} ]]; then
    echo "$label: ガチャ直近履歴クエリが大量の行をFilterしている" >&2
    echo "$plan" >&2
    exit 1
  fi

  echo "$label plan: $(echo "$plan" | grep -E 'Index (Only )?Scan|Execution Time' | tr -s ' ' | tr '\n' ' ')"
}

assert_latest_plan "$STALE_STREAMER" "stale heavy (直近が古い20万件)"
assert_latest_plan "$ACTIVE_STREAMER" "active heavy (直近30日の20万件)"
assert_latest_plan "$LIGHT_STREAMER" "light (履歴3件)"

echo "gacha latest history plan checks passed"
