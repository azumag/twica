#!/usr/bin/env bash
# OpenNext が生成した Worker (.open-next/worker.js) を workerd 上で実際に起動し、
# 初期化例外なしにリクエストを捌けることを確認するスモークテスト。
#
# 背景 (2026-10-21 preview 全ルート 500 障害):
#   Next.js を 16.2.12 -> 16.4.2 に上げたが @opennextjs/cloudflare は 1.20.2 のままだった。
#   `opennextjs-cloudflare build` は成功し、`next build` も unit test も通ったが、
#   Worker 起動後の初期化 (new NextNodeServer -> getPreviewProps -> loadManifest) で
#   `Unexpected loadManifest(/.next/server/preview-props.json) call!` が投げられ、
#   全ルートが本文なしの HTTP 500 になった。ビルドは「manifest を build 時にインライン化する」
#   パッチが Next の新しい内部構造にマッチしなくても成功してしまう (サイレント失敗) ため、
#   ビルド成功だけでは検出できない。
#
# なぜ peer dependency 検査ではなくこのスモークテストか:
#   1.20.2 の peer は `next: >=15.5.21 <16 || >=16.2.11` で 16.4.2 を「許容」していた。
#   peer 範囲は上流が未検証の将来バージョンも含むため、`npm ls` の peer 警告では
#   今回の不整合は検出できない。実際に起動して叩くのが唯一確実な検出手段 (業界標準の
#   「ビルド成果物に対する起動スモークテスト」)。
#
# 検証対象は DB 接続を必要としないルートに限る (Hyperdrive 未接続でも 200 になる):
#   /                        ルートレイアウト + SSR 初期化
#   /guide/trade             静的寄りのページ
#   /api/maintenance-status  Route Handler
# ここでの目的は「初期化例外が無いこと」であり、アプリのロジック検証ではない。
#
# 使い方: npm run workers:build の後に実行する。
#   bash scripts/smoke-opennext-worker.sh
set -euo pipefail

PORT="${SMOKE_PORT:-8799}"
READY_TIMEOUT_SEC="${SMOKE_READY_TIMEOUT_SEC:-90}"
# wrangler dev の最大生存時間。異常時に孤児プロセスが残らないよう必ず上限を付ける。
HARD_TIMEOUT_SEC="${SMOKE_HARD_TIMEOUT_SEC:-240}"

if [[ ! -f .open-next/worker.js ]]; then
  echo "ERROR: .open-next/worker.js not found. Run 'npm run workers:build' first." >&2
  exit 2
fi

WORK_DIR="$(mktemp -d)"
LOG_FILE="$WORK_DIR/wrangler.log"
ENV_FILE="$WORK_DIR/dev.vars"
WRANGLER_PID=""

cleanup() {
  # wrangler は workerd を子プロセスとして起動するため、親子とも確実に止める。
  if [[ -n "$WRANGLER_PID" ]]; then
    pkill -P "$WRANGLER_PID" 2>/dev/null || true
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# 起動に必要な最小限のダミー値 (実 secret は使わない。長さ要件のみ満たす)。
cat > "$ENV_FILE" <<ENV
CSRF_TOKEN_SALT=smoke_dummy_csrf_salt_at_least_32_chars_long
SESSION_COOKIE_SECRET=smoke_dummy_session_secret_at_least_32_chars
TWITCH_CLIENT_SECRET=smoke_dummy
TWITCH_EVENTSUB_SECRET=smoke_dummy_eventsub
NEXT_PUBLIC_APP_URL=http://localhost:${PORT}
ENV

timeout "$HARD_TIMEOUT_SEC" npx wrangler dev --port "$PORT" --env-file "$ENV_FILE" \
  > "$LOG_FILE" 2>&1 &
WRANGLER_PID=$!

ready=0
for _ in $(seq 1 "$READY_TIMEOUT_SEC"); do
  if grep -q "Ready on" "$LOG_FILE" 2>/dev/null; then ready=1; break; fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "ERROR: wrangler dev did not become ready. Log:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

fail=0
for path in / /guide/trade /api/maintenance-status; do
  status="$(curl -s -m 60 -o /dev/null -w '%{http_code}' "http://localhost:${PORT}${path}" || true)"
  echo "GET ${path} -> ${status}"
  # 初期化失敗は全ルート 5xx になる。000 は接続不能 (curl 失敗)。
  if [[ -z "$status" || "$status" == "000" || "$status" -ge 500 ]]; then
    fail=1
  fi
done

# ステータスが通っても、初期化系の例外が Worker ログに出ていれば失敗扱いにする。
if grep -q "Unexpected loadManifest" "$LOG_FILE"; then
  echo "ERROR: 'Unexpected loadManifest' found in Worker log (OpenNext manifest inlining is broken)." >&2
  fail=1
fi

if [[ "$fail" != "0" ]]; then
  echo "OpenNext Worker smoke test FAILED. Worker log:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
echo "OpenNext Worker smoke test passed."
