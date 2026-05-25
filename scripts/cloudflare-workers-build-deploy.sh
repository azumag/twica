#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
mode="${2:-deploy}"

if [[ "$target" != "production" && "$target" != "preview" ]]; then
  echo "Usage: $0 <production|preview> [deploy|upload]" >&2
  exit 2
fi

if [[ "$mode" != "deploy" && "$mode" != "upload" ]]; then
  echo "Usage: $0 <production|preview> [deploy|upload]" >&2
  exit 2
fi

branch="${WORKERS_CI_BRANCH:-}"
if [[ -z "$branch" ]]; then
  branch="$(git branch --show-current 2>/dev/null || true)"
fi
branch="${branch:-unknown}"

case "$target:$mode" in
  production:deploy)
    expected_branch="main"
    deploy_command=(npm run workers:deploy)
    ;;
  preview:deploy)
    expected_branch="preview"
    deploy_command=(npm run workers:deploy:preview)
    ;;
  production:upload)
    expected_branch=""
    deploy_command=(npx opennextjs-cloudflare upload)
    ;;
  preview:upload)
    expected_branch=""
    deploy_command=(npx opennextjs-cloudflare upload --env preview)
    ;;
esac

if [[ "$mode" == "deploy" ]]; then
  if [[ "$branch" != "$expected_branch" ]]; then
    echo "Refusing to deploy $target from branch '$branch'; expected '$expected_branch'." >&2
    exit 1
  fi

  if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
    echo "SUPABASE_DB_URL is required before deploying $target." >&2
    exit 1
  fi

  npx supabase db push --db-url "$SUPABASE_DB_URL" --yes
fi

"${deploy_command[@]}"
