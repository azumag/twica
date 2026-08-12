/**
 * URL関連のユーティリティ関数
 */

import { logger } from './logger'

// #836 項目6: getBaseUrl は host ヘッダーを無検証で信頼していた。
// Cloudflare Workers は workers.dev + カスタムドメイン + preview の複数ホストを
// 受けるため、ホストヘッダ注入で OAuth redirect_uri / リダイレクト先を混線させる
// リスクがある。許可 origin（scheme + host + port）以外の host ヘッダーは無視し、
// NEXT_PUBLIC_APP_URL へフォールバックする。
//
// 注意: NEXT_PUBLIC_* は Cloudflare Workers ではビルド時にインライン化されるため、
// この allowlist もビルド時に確定する。許可 host は次の3系統。
// 1. ローカル開発（NODE_ENV !== 'production' のときだけ）
// 2. カスタムドメイン（NEXT_PUBLIC_APP_URL の origin。warn を出さない正規 origin）
// 3. workers.dev（tsubasa-azumagakito.workers.dev 配下。suffix 一致でまとめて許可）
//    - 本番 Worker: twica.tsubasa-azumagakito.workers.dev（既存の公開 URL。ここから
//      OAuth を開始しても同一 origin で callback が成立する必要がある）
//    - 安定 preview: twica-preview.tsubasa-azumagakito.workers.dev
//    - Workers Builds が生成するブランチ/コミット単位の preview Worker:
//      <branch>-twica-preview.<subdomain>.workers.dev / <version>-twica.<subdomain>.workers.dev 等
//    - workers.dev のサブドメインはアカウント専有（このアカウント以外はデプロイ
//      できない）ため、suffix 一致で第三者が偽装することはできない。

const LOCAL_DEV_ORIGINS = new Set([
  'http://localhost:8787',
  'http://localhost:3000',
  'http://127.0.0.1:8787',
  'http://127.0.0.1:3000',
])

const WORKERS_DEV_ACCOUNT_SUBDOMAIN = '.tsubasa-azumagakito.workers.dev'

/**
 * workers.dev の host がこのアカウントの twica 系 Worker に属するか判定する。
 * アカウント専有サブドメインであるため第三者は偽装できないが、不正な Host
 * （空白・記号・userinfo 混入）が誤って通ると、呼び出し側の `new URL()` が
 * 500 になるか origin が別ホストへすり替わる。文字種を検証して fail-closed にする。
 */
function isTwicaWorkersDevHost(normalizedHost: string): boolean {
  // endsWith だけだと `twica.preview@evil.tsubasa-...` のような userinfo 混入が
  // 末尾一致で通過するため、ホスト全体がドット区切り label であることを確認する。
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(normalizedHost)) {
    return false
  }
  if (!normalizedHost.endsWith(WORKERS_DEV_ACCOUNT_SUBDOMAIN)) {
    return false
  }
  // worker 名（先頭 label）に twica を含む。Workers Builds は
  // `<version>-twica-preview` / `<branch>-twica-preview` の形でサブドメインを生成する。
  // 全体の文字種検証が済んでいるため先頭 label の再検証は不要。
  return normalizedHost.split('.')[0].includes('twica')
}

/** フォールバック先の origin を解決する。production で未設定/不正なら fail-loud。 */
function resolveFallbackOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      // サイレントに localhost へ倒すと OAuth redirect_uri が全滅し、気付く手段が
      // 無い。設定ミスはリクエスト時に即座に検知する（#836 レビュー指摘）。
      throw new Error('NEXT_PUBLIC_APP_URL is required in production')
    }
    return 'http://localhost:8787'
  }
  try {
    return new URL(raw).origin
  } catch {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`NEXT_PUBLIC_APP_URL is invalid in production: ${raw}`)
    }
    return 'http://localhost:8787'
  }
}

/**
 * origin 文字列（scheme+host+port）がこのアプリの正規 origin か判定する。
 * getBaseUrl と同じ allowlist 判定を CSRF 検証（src/lib/csrf.ts）と共有し、
 * 非許可 authority からの状態変更リクエストを fail-closed にする（#950）。
 */
export function isTrustedOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  const normalizedHost = url.host.toLowerCase()

  // ローカル開発は host ヘッダーのみで判定。この分岐は NODE_ENV !== 'production'
  // （next dev / vitest）でだけ通り、npm run dev（wrangler dev）は production 相当。
  if (process.env.NODE_ENV !== 'production' && LOCAL_DEV_ORIGINS.has(url.origin)) {
    return true
  }
  // workers.dev は常に https
  if (url.protocol === 'https:' && isTwicaWorkersDevHost(normalizedHost)) {
    return true
  }
  // カスタムドメイン（NEXT_PUBLIC_APP_URL）
  const fallback = process.env.NEXT_PUBLIC_APP_URL
  if (fallback) {
    try {
      if (url.origin === new URL(fallback).origin) return true
    } catch {
      // NEXT_PUBLIC_APP_URL が不正な場合は workers.dev 判定のみで fail-closed
    }
  }
  return false
}

/**
 * リクエストから正規化された許可 origin を解決する。
 * 許可 origin（ローカル開発 / カスタムドメイン / workers.dev）に一致する host のみ採用し、
 * それ以外は NEXT_PUBLIC_APP_URL の origin を返す（fail-closed）。port を含む完全一致で
 * 検証するため、許可ホストに任意ポートを付けた偽装を拒否する。
 *
 * NEXT_PUBLIC_APP_URL の解決は allowlist 判定後の遅延評価。production で設定漏れが
 * あっても workers.dev からの正規アクセスは維持される（ビルド設定漏れに備えた二重防御）。
 */
export function resolveAllowedOrigin(host: string | null): string {
  if (!host) return resolveFallbackOrigin()

  const normalizedHost = host.toLowerCase()
  // ローカル開発は host ヘッダーのみで判定（LOCAL_DEV_ORIGINS 完全一致のみ許可）。
  // production ビルドでは localhost を許可しない（Host ヘッダ注入の抜け穴を塞ぐ）。
  if (process.env.NODE_ENV !== 'production') {
    const localOrigin = `http://${normalizedHost}`
    if (LOCAL_DEV_ORIGINS.has(localOrigin)) return localOrigin
  }

  // workers.dev は常に https（workers.dev は http を受け付けない）
  if (isTwicaWorkersDevHost(normalizedHost)) {
    return `https://${normalizedHost}`
  }

  const fallbackOrigin = resolveFallbackOrigin()
  // カスタムドメイン（NEXT_PUBLIC_APP_URL）は正規 origin のため warn を出さない
  // （異常検知シグナルの false positive を防ぐ）。
  if (new URL(fallbackOrigin).host === normalizedHost) {
    return fallbackOrigin
  }

  // 許可外ホストを無言でフォールバックすると、NEXT_PUBLIC_APP_URL と実配信ホストの
  // ズレに気付けず OAuth が全滅する。Cloudflare は Host でルーティングするため大量
  // 発生はしにくいが、Workers Logs のコストを抑えるため debug で手掛かりを残す。
  // host は外部入力のため、制御文字を除去し長さを制限してから出力する（ログ汚染対策）。
  const sanitizedHost = host.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128)
  logger.debug(`[url-utils] Disallowed host detected, falling back to NEXT_PUBLIC_APP_URL: ${sanitizedHost}`)
  return fallbackOrigin
}

/**
 * リクエストからベースURLを取得する
 * 許可リスト（ローカル開発 / カスタムドメイン / workers.dev）に一致する host のみ採用し、
 * それ以外は NEXT_PUBLIC_APP_URL の origin を返す（fail-closed）。
 *
 * @param request - HTTPリクエスト
 * @returns ベースURL（例: http://localhost:8787, https://example.com）
 */
export function getBaseUrl(request: Request): string {
  return resolveAllowedOrigin(request.headers.get('host'))
}
