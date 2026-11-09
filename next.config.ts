import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";
import { execSync } from "child_process";

// Create next-intl plugin with custom request config path
// next-intlプラグインを作成（カスタムリクエスト設定パス指定）
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Issue #569: overlay(src/app/overlay/[streamerId]/page.tsx)は何週間も
 * リロードされずに動き続けるため、クライアント側の変更を全クライアントへ
 * 浸透させる手段として「ビルドごとに一意なバージョン識別子」を注入する。
 *
 * 解決順序:
 * 1. WORKERS_CI_COMMIT_SHA — Cloudflare Workers Builds がCIビルド時に自動的に
 *    提供するコミットSHA。本番/プレビューのCI経由ビルドでは常にこれが使える。
 * 2. `git rev-parse` でローカルHEADのSHAを取得する。CI変数が無い
 *    ローカル `next build` 実行時のフォールバック。
 * 3. 上記がいずれも失敗した場合(gitが無い/.gitが無い環境、shallow clone等)は
 *    'dev' を返す。バージョン識別子が取れないという理由でビルド自体を
 *    失敗させたくないため、execSyncはtry/catchで包む。
 *
 * 12桁に揃えるのは、GitHub/CloudflareのUIで通常表示されるSHA桁数と
 * 揃えつつ、衝突確率を十分に低く保つため。
 */
function resolveOverlayVersion(): string {
  if (process.env.WORKERS_CI_COMMIT_SHA) {
    return process.env.WORKERS_CI_COMMIT_SHA.slice(0, 12);
  }
  try {
    return execSync("git rev-parse --short=12 HEAD", {
      encoding: "utf-8",
      // ビルドプロセスの標準エラー出力にgitの警告等を漏らさない
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // git 不在 / .git 不在(Dockerビルド等)でもビルドを落とさない
    return "dev";
  }
}

const nextConfig: NextConfig = {
  // next.config の `env` はここで解決した値をビルド時に文字列としてサーバー・
  // クライアント両方のバンドルへインライン化する(process.env.NEXT_PUBLIC_*の
  // ような静的置換と同じ扱いで、実行時にサーバー環境変数を追加設定する必要はない)。
  // https://nextjs.org/docs/pages/api-reference/next-config-js/env
  env: {
    NEXT_PUBLIC_OVERLAY_VERSION: resolveOverlayVersion(),
  },
  images: {
    // Minimized allowlist (follow-up to #1898 / issue #1909).
    // Previously `hostname: "**"` allowed any HTTPS host for next/image, which
    // kept the SSRF surface open for the image-optimization endpoint even though
    // every actual <Image> usage sets `unoptimized`. Enumerate only the host
    // families that can legitimately serve card/profile images:
    //   - R2 public URLs (custom domain via R2_PUBLIC_URL / R2_SOUND_PUBLIC_URL
    //     when available at build time, plus the default r2.dev / r2.cloudflarestorage.com families)
    //   - Twitch CDN (streamer profile images)
    //   - The app's own Cloudflare zone (transformable same-zone images)
    // Arbitrary hosts are no longer allowed; API-level jpg/png validation remains.
    remotePatterns: [
      ...(["R2_PUBLIC_URL", "R2_SOUND_PUBLIC_URL", "NEXT_PUBLIC_APP_URL"]
        .map((name) => process.env[name])
        .filter((v): v is string => Boolean(v))
        .map((v) => {
          try {
            return new URL(v).hostname;
          } catch {
            return null;
          }
        })
        .filter((h): h is string => Boolean(h))
        .map((hostname) => ({ protocol: "https" as const, hostname }))),
      { protocol: "https", hostname: "*.r2.dev" },
      { protocol: "https", hostname: "*.r2.cloudflarestorage.com" },
      { protocol: "https", hostname: "*.jtvnw.net" },
      { protocol: "https", hostname: "*.bluemoon.works" },
    ],
  },
};

export default withNextIntl(nextConfig);
