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
    expected_branch="main"
    deploy_command=(npx opennextjs-cloudflare upload)
    ;;
  preview:upload)
    expected_branch="preview"
    deploy_command=(npx opennextjs-cloudflare upload --env preview)
    ;;
esac

# Branch control in Cloudflare is the primary cost control. This guard remains
# as defense-in-depth so a future dashboard drift cannot make feature branches
# upload or deploy a Worker after the build-side guard skipped OpenNext.
if [[ "${WORKERS_CI:-}" == "1" && "$branch" != "$expected_branch" ]]; then
  echo "Skipping Cloudflare $mode for $target on Workers Builds branch '$branch'; only '$expected_branch' is deployable."
  exit 0
fi

if [[ "$mode" == "deploy" && "$branch" != "$expected_branch" ]]; then
  if [[ "$target" == "preview" ]]; then
    echo "Uploading preview version for non-preview branch '$branch' instead of deploying." >&2
    deploy_command=(npx opennextjs-cloudflare upload --env preview)
    "${deploy_command[@]}"
    exit 0
  fi

  echo "Refusing to deploy $target from branch '$branch'; expected '$expected_branch'." >&2
  exit 1
fi

# deploy は build と別プロセスで実行されるため、build スクリプトで export した値は届かない。
# OpenNext の deploy/upload が @swc/core を読み込んでも同じ検査で落ちないよう、同じ設定を入れる。
# shellcheck source=scripts/lib/workers-ci-swc-native-cache.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/workers-ci-swc-native-cache.sh"

"${deploy_command[@]}"
