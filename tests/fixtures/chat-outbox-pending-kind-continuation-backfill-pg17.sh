#!/usr/bin/env bash
# Issue #1665 Step 4 の回帰 fixture。
#
# 20261017010000（打ち切り版 backfill）が preview へ適用済みになった後、owner レビュー
# （pullrequestreview-5553255808）の依頼で、次の経路を「実 db-migrate の apply」で固定する:
#
#   1. 対象 201 行を用意する
#   2. 旧 migration（20261017010000, CTE + LIMIT 200）を apply      → 1件適用 / 残件 1
#   3. 通常の再 apply（履歴登録済みなので実行されない）             → 0件適用 / 残件 1  ← P2 の本体
#   4. 補完 migration（20261018010000, 打ち切りなし）を apply       → 1件適用 / 残件 0
#   5. 通常の再 apply                                              → 0件適用 / 残件 0（不変）
#
# 2 と 3 の差が P2 そのもの（SQL を直接再実行すれば収束するが、db-migrate は履歴登録済みの
# version を再実行しない）。3 の状態が「残件を残したまま適用済みとして確定した」状態であり、
# 4 がその補正、5 が冪等（他環境で残件0なら no-op）の確認にあたる。
#
# 前提:
#   - PostgreSQL 17（CI の planetscale-migration-postgres job と同じ major）
#   - DATABASE_URL が「空の」データベースを指していること。twica のスキーマや migration 履歴が
#     既にある DB を渡すと、前提が壊れるため先頭で fail する（使い捨てのDBを渡すこと）。
#   - repo ルートで実行（git リポジトリ内であること）。runner が repo 内の migration を直接読む。
#
# 実行コマンド（例）:
#   createdb -h 127.0.0.1 -p 5432 twica_1665_fixture
#   DATABASE_URL="postgres://postgres@127.0.0.1:5432/twica_1665_fixture" \
#     bash tests/fixtures/chat-outbox-pending-kind-continuation-backfill-pg17.sh
#
# 注意: この fixture は渡された DB に twica のスキーマ・履歴・検証用行を作る。本番/preview の
# DB には絶対に実行しないこと。実行中は migration ファイル 2 本を一時退避し、EXIT trap で必ず戻す
# （どの migration が pending かを見せるための staging）。
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

MIGRATIONS_DIR="db/planetscale/migrations"
OLD_MIG="20261017010000_chat_outbox_pending_kind_continuation_backfill.sql"
NEW_MIG="20261018010000_chat_outbox_pending_kind_continuation_backfill_completion.sql"
BASELINE_VERSION="20260719180100"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL を、空の PostgreSQL 17 データベースへ向けて設定してください。" >&2
  exit 1
fi

PSQL=(psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL")

fail() { echo "FIXTURE FAIL: $*" >&2; exit 1; }
assert_eq() { # $1 label, $2 expected, $3 actual
  if [ "$2" != "$3" ]; then fail "$1: 期待 $2 / 実際 $3"; fi
  echo "  PASS  $1 = $3"
}

# --- migration ファイルの staging（EXIT で必ず戻す） -------------------------------------------
STASH_DIR=$(mktemp -d)
restore_migrations() {
  for f in "$OLD_MIG" "$NEW_MIG"; do
    if [ -f "$STASH_DIR/$f" ]; then mv "$STASH_DIR/$f" "$MIGRATIONS_DIR/$f"; fi
  done
  rm -rf "$STASH_DIR"
}
trap restore_migrations EXIT
for f in "$OLD_MIG" "$NEW_MIG"; do
  [ -f "$MIGRATIONS_DIR/$f" ] || fail "migration が見つかりません: $MIGRATIONS_DIR/$f"
  mv "$MIGRATIONS_DIR/$f" "$STASH_DIR/$f"
done

# --- 前提: 空のDBか ----------------------------------------------------------------------------
existing=$("${PSQL[@]}" -Atc "select coalesce(to_regclass('public.chat_notification_outbox')::text, '') || '|' || coalesce(to_regclass('twica_meta.schema_migrations')::text, '')")
assert_eq "前提: 空のDB（スキーマ・履歴なし）" "|" "$existing"

residual() { # 補正対象（partial cursor かつ pending/lease失効 processing かつ initial）の残件数
  "${PSQL[@]}" -Atc "
SELECT count(*) FROM public.chat_notification_outbox
WHERE (status = 'pending' OR (status = 'processing' AND lease_expires_at <= now()))
  AND delivery_cursor > 0 AND delivery_cursor < expected_draw_count
  AND pending_kind = 'initial'"
}

run_apply() { # $1 = label。APPLIED に適用件数を入れる（履歴登録済み version は再実行されない）
  local out
  if ! out=$(node scripts/db-migrate.js apply --provider=planetscale 2>&1); then
    echo "$out" >&2
    fail "$1: db-migrate apply が失敗しました"
  fi
  # 適用対象が無い場合は `結果: {} (対象 0件)` になり "applied" キーが出ないため、
  # サマリの「対象 N件」を適用件数として読む。
  APPLIED=$(printf '%s' "$out" | sed -n 's/.*(対象 \([0-9]*\)件).*/\1/p' | tail -1)
  if [ -z "${APPLIED:-}" ]; then
    echo "$out" >&2
    fail "$1: apply サマリから適用件数を取得できませんでした"
  fi
}

echo "== 1. baseline と 20261017010000 より前の migration を適用（CI の PG17 job と同じ順序） =="
"${PSQL[@]}" -1 -f "$MIGRATIONS_DIR/20260719180000_planetscale_bootstrap.sql" >/dev/null
"${PSQL[@]}" -1 -f "$MIGRATIONS_DIR/20260719180100_planetscale_public_schema_baseline.sql" >/dev/null
"${PSQL[@]}" -1 -f db/planetscale/grants.sql >/dev/null

descriptors=$(LOWER="$BASELINE_VERSION" node -e '
const path = require("node:path");
const core = require("./scripts/lib/db-migrate-core");
const descriptors = core.loadMigrationFilesFromDirs([
  path.resolve("supabase/migrations"),
  path.resolve("db/planetscale/migrations"),
]);
const errors = core.collectDescriptorErrors(descriptors);
if (errors.length > 0) { console.error(JSON.stringify(errors)); process.exit(1); }
for (const d of descriptors) {
  if (BigInt(d.version) > BigInt(process.env.LOWER) && core.isProviderApplicable(d, "planetscale")) {
    console.log(d.transaction + "\t" + path.join(d.sourceDir, d.filename));
  }
}
') || fail "migration descriptor の解析に失敗しました"

while IFS=$'\t' read -r transaction file; do
  [ -z "${transaction:-}" ] && continue
  if [ "$transaction" = "forbidden" ]; then
    "${PSQL[@]}" -f "$file" >/dev/null
  else
    "${PSQL[@]}" -1 -f "$file" >/dev/null
  fi
done <<< "$descriptors"

# psql で実行済みの内容を、migration 履歴へ「実行せず登録」する（既存DBの台帳を作る正規手順）。
# これにより 20261017010000 と 20261018010000 だけが pending になる。
node scripts/db-migrate.js apply --provider=planetscale --bootstrap >/dev/null

expected_versions=$(node -e '
const path = require("node:path");
const core = require("./scripts/lib/db-migrate-core");
const descriptors = core.loadMigrationFilesFromDirs([
  path.resolve("supabase/migrations"),
  path.resolve("db/planetscale/migrations"),
]);
let count = 0;
for (const d of descriptors) {
  if (core.isProviderApplicable(d, "planetscale")) count += 1;
}
console.log(count);
') || fail "migration descriptor の計数に失敗しました"
history_count=$("${PSQL[@]}" -Atc "select count(*) from twica_meta.schema_migrations")
assert_eq "bootstrap 後の履歴件数（= provider 対象 migration 数。退避した2本は含まない）" "$expected_versions" "$history_count"

echo
echo "== 2. 対象 201 行（pending partial 200 + lease失効 processing partial 1）+ 対象外の制御行 =="
"${PSQL[@]}" >/dev/null <<'SQL'
-- 制御行。対象集合に入るのは ctl-lease-expired だけ（partial cursor かつ lease 失効かつ initial）。
-- 打ち切り版は ORDER BY created_at, id + LIMIT 200 なので、created_at を最古にして
-- 「対象 201 行のうち ctl-lease-expired + res-1..199 が補正され、res-200 が残る」状態を決定的に作る。
INSERT INTO public.chat_notification_outbox
  (batch_id, payload, expected_draw_count, assembled_draw_count, status, created_at)
VALUES
  ('ctl-cursor0', '{}'::jsonb, 12, 12, 'pending', '2025-12-01T00:00:00Z'),
  ('ctl-complete', '{}'::jsonb, 12, 12, 'pending', '2025-12-01T00:00:01Z'),
  ('ctl-retry', '{}'::jsonb, 12, 12, 'pending', '2025-12-01T00:00:02Z'),
  ('ctl-leased', '{}'::jsonb, 12, 12, 'pending', '2025-12-01T00:00:03Z'),
  ('ctl-lease-expired', '{}'::jsonb, 12, 12, 'pending', '2025-12-01T00:00:04Z');
UPDATE public.chat_notification_outbox SET delivery_cursor = 12 WHERE batch_id = 'ctl-complete';
UPDATE public.chat_notification_outbox SET delivery_cursor = 5
  WHERE batch_id IN ('ctl-retry', 'ctl-leased', 'ctl-lease-expired');
UPDATE public.chat_notification_outbox SET pending_kind = 'retry' WHERE batch_id = 'ctl-retry';
UPDATE public.chat_notification_outbox
SET status = 'processing', lease_id = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes'
WHERE batch_id = 'ctl-leased';
UPDATE public.chat_notification_outbox
SET status = 'processing', lease_id = gen_random_uuid(), lease_expires_at = now() - interval '1 minute'
WHERE batch_id = 'ctl-lease-expired';

-- 対象: partial cursor の pending 行 200 行（打ち切り版が取り残した想定の残件）。
-- created_at を1秒ずつ進め、補正対象の順序を決定的にする。
INSERT INTO public.chat_notification_outbox
  (batch_id, payload, expected_draw_count, assembled_draw_count, status, next_attempt_at, created_at)
SELECT 'res-' || g, '{}'::jsonb, 12, 12, 'pending', now(),
       '2026-01-01T00:00:00Z'::timestamptz + (g || ' seconds')::interval
FROM generate_series(1, 200) g;
UPDATE public.chat_notification_outbox SET delivery_cursor = 5 WHERE batch_id LIKE 'res-%';

-- 打ち切り版が上限内で補正済みだった行（200行・既に continuation）。何も変更されないこと。
INSERT INTO public.chat_notification_outbox
  (batch_id, payload, expected_draw_count, assembled_draw_count, status, pending_kind, created_at)
SELECT 'done-' || g, '{}'::jsonb, 12, 12, 'pending', 'continuation',
       '2026-02-01T00:00:00Z'::timestamptz + (g || ' seconds')::interval
FROM generate_series(1, 200) g;
UPDATE public.chat_notification_outbox SET delivery_cursor = 5 WHERE batch_id LIKE 'done-%';
SQL
assert_eq "seed 直後の残件（対象 201 行）" "201" "$(residual)"

echo
echo "== 3. 旧 migration（打ち切り版）を apply =="
mv "$STASH_DIR/$OLD_MIG" "$MIGRATIONS_DIR/$OLD_MIG"
run_apply "旧 migration apply"
assert_eq "旧 apply の適用件数" "1" "$APPLIED"
assert_eq "旧 apply 後の残件（打ち切りで1行残る）" "1" "$(residual)"
assert_eq "残ったのは窓から外れた res-200（決定的）" "res-200" "$("${PSQL[@]}" -Atc "
SELECT batch_id FROM public.chat_notification_outbox
WHERE (status = 'pending' OR (status = 'processing' AND lease_expires_at <= now()))
  AND delivery_cursor > 0 AND delivery_cursor < expected_draw_count
  AND pending_kind = 'initial'")"
assert_eq "lease 失効 processing は旧 apply で補正済み" "continuation" "$("${PSQL[@]}" -Atc "select pending_kind from public.chat_notification_outbox where batch_id='ctl-lease-expired'")"

echo
echo "== 4. 通常の再 apply（履歴登録済みなので再実行されない = P2 の本体） =="
run_apply "再 apply（旧 migration は skip）"
assert_eq "再 apply の適用件数（再実行されない）" "0" "$APPLIED"
assert_eq "再 apply 後も残件が残る" "1" "$(residual)"

echo
echo "== 5. 補完 migration を apply =="
mv "$STASH_DIR/$NEW_MIG" "$MIGRATIONS_DIR/$NEW_MIG"
run_apply "補完 migration apply"
assert_eq "補完 apply の適用件数" "1" "$APPLIED"
assert_eq "補完後の残件（1回で収束）" "0" "$(residual)"

echo
echo "== 6. 通常の再 apply（冪等 / no-op） =="
run_apply "再 apply（補完 migration は skip）"
assert_eq "再 apply の適用件数" "0" "$APPLIED"
assert_eq "再 apply 後の残件（不変）" "0" "$(residual)"

echo
echo "== 7. 対象外の行が変更されていないこと =="
assert_eq "ctl-cursor0 は initial のまま" "initial" "$("${PSQL[@]}" -Atc "select pending_kind from public.chat_notification_outbox where batch_id='ctl-cursor0'")"
assert_eq "ctl-complete は initial のまま" "initial" "$("${PSQL[@]}" -Atc "select pending_kind from public.chat_notification_outbox where batch_id='ctl-complete'")"
assert_eq "ctl-retry は retry のまま" "retry" "$("${PSQL[@]}" -Atc "select pending_kind from public.chat_notification_outbox where batch_id='ctl-retry'")"
assert_eq "lease 有効中 processing は initial のまま" "initial" "$("${PSQL[@]}" -Atc "select pending_kind from public.chat_notification_outbox where batch_id='ctl-leased'")"
assert_eq "lease 失効 processing は continuation" "continuation" "$("${PSQL[@]}" -Atc "select pending_kind from public.chat_notification_outbox where batch_id='ctl-lease-expired'")"
assert_eq "既に continuation の行が initial に戻っていない" "0" "$("${PSQL[@]}" -Atc "select count(*) from public.chat_notification_outbox where batch_id like 'done-%' and pending_kind <> 'continuation'")"
assert_eq "delivery_cursor が保持されている（5 のまま）" "200" "$("${PSQL[@]}" -Atc "select count(*) from public.chat_notification_outbox where batch_id like 'res-%' and delivery_cursor = 5")"
assert_eq "補正後の continuation 行数（res 200 + done 200 + lease失効 1）" "401" "$("${PSQL[@]}" -Atc "select count(*) from public.chat_notification_outbox where pending_kind='continuation'")"

echo
echo "CHAT_OUTBOX_BACKFILL_FIXTURE_OK"
