#!/usr/bin/env bash
set -euo pipefail

# Workers Builds used to run the full OpenNext build for every feature-branch
# push. TwiCa has dedicated long-lived deployment branches (`main` and
# `preview`), so feature branches do not need a Cloudflare build artifact.
#
# Keep this as a repository-side safety net even after Branch control is fixed
# in Cloudflare. Branch control prevents the build from starting at all (and is
# therefore the primary cost control); this guard prevents an accidental future
# dashboard change from turning every PR push back into a full OpenNext build.
if [[ "${WORKERS_CI:-}" == "1" ]]; then
  branch="${WORKERS_CI_BRANCH:-}"
  if [[ "$branch" != "main" && "$branch" != "preview" ]]; then
    echo "Skipping OpenNext build on Workers Builds branch '${branch:-unknown}'. Only main/preview are deployable."
    exit 0
  fi
fi

exec npx opennextjs-cloudflare build
