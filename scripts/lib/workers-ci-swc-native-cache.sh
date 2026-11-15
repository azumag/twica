# shellcheck shell=bash
# Workers Builds（WORKERS_CI=1）専用: @swc/core のネイティブアドオン展開先を設定する。
# scripts/cloudflare-workers-build.sh と scripts/cloudflare-workers-build-deploy.sh が
# source する。実行ファイルではない（`bash` 経由でも直接実行しない）。
#
# 背景（2026-11-15 実測）:
#   @swc/core 1.16.x のネイティブパッケージは圧縮された「carrier」で、読み込み時に
#   ユーザーキャッシュ（XDG_CACHE_HOME / ~/.cache、失敗時は TMPDIR）へ展開する。その際、
#   キャッシュルートの全祖先ディレクトリが「他ユーザーに置き換えられない」ことを検査する。
#   Workers Builds のビルドコンテナでは /opt/buildhome/.cache と /tmp の両方がこの検査に落ち、
#   next.config.ts の読み込み（next-intl plugin が @swc/core を require）で
#   `ERR_SWC_NATIVE_CACHE ... cache root has a parent writable by another user without
#   trusted sticky protection` となって、preview のビルドが c63074c5 以降すべて失敗した。
#   lockfile・Node 版（22.23.4）・build 設定は最後に成功した 86faa7e8（2026-11-11）と同一なので、
#   ビルドイメージ側の権限変更と推定している（未確認。下の診断出力で確かめる）。
#   GitHub Actions（CI の Application build）では同じ lockfile で成功する。
#
# 対処:
#   SWC 公式の opt-out（docs/native-addon-carriers.md）である
#   SWC_NATIVE_BINDING_CACHE_SKIP_SECURITY_CHECK=1 を、Workers Builds の中だけで有効にする。
#   この検査は「同じマシンの別ユーザーが展開済みアドオンを差し替える」攻撃を防ぐもので、
#   Workers Builds は1ビルド1コンテナの使い捨て環境で、別ユーザーの常駐が無い。SWC の
#   ドキュメントも「isolated Jenkins executors のような信頼できる環境」向けの opt-out として
#   いる。opt-out しても、キャッシュ内の private namespace・ファイル検査は残る。
#   展開先は mktemp -d で作る新しい 0700 ディレクトリにし、他のツールのキャッシュと共有しない。
#   ローカル開発と GitHub Actions には影響させない（WORKERS_CI=1 のときだけ設定）。
if [[ "${WORKERS_CI:-}" == "1" ]]; then
  # 失敗した祖先がどれかはログに出ないため、原因の切り分け用に権限を残す（秘密情報は含まない）。
  echo "[swc-native-cache] uid/gid: $(id)"
  ls -ld / /opt /opt/buildhome /opt/buildhome/.cache /tmp 2>&1 | sed 's/^/[swc-native-cache] /' || true

  swc_native_cache_dir="$(mktemp -d)"
  chmod 700 "$swc_native_cache_dir"
  export SWC_NATIVE_BINDING_CACHE="$swc_native_cache_dir"
  export SWC_NATIVE_BINDING_CACHE_SKIP_SECURITY_CHECK=1
  echo "[swc-native-cache] SWC_NATIVE_BINDING_CACHE=$SWC_NATIVE_BINDING_CACHE (security check skipped on Workers Builds only)"
fi
