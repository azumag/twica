/**
 * URL関連のユーティリティ関数
 */

// #836 項目6: getBaseUrl は host ヘッダーを無検証で信頼していた。
// Cloudflare Workers は workers.dev + カスタムドメイン + preview の複数ホストを
// 受けるため、ホストヘッダ注入で OAuth redirect_uri / リダイレクト先を混線させる
// リスクがある。許可 origin（scheme + host + port）以外の host ヘッダーは無視し、
// NEXT_PUBLIC_APP_URL へフォールバックする。
//
// 注意: NEXT_PUBLIC_* は Cloudflare Workers ではビルド時にインライン化されるため、
// この allowlist もビルド時に確定する。production の NEXT_PUBLIC_APP_URL には
// カスタムドメイン（https://twica.bluemoon.works）が設定される前提。
// 念のため workers.dev ドメインも定数として許可する（ビルド設定の漏れに備えた
// 二重防御）。production Worker（twica.tsubasa-azumagakito.workers.dev）は既存の
// 公開 URL であり、ここから OAuth を開始した場合も同一 origin で callback が
// 成立する必要がある（#836 レビュー指摘）。
const WORKERS_DEV_ALLOWED_ORIGINS = new Set([
  'https://twica.tsubasa-azumagakito.workers.dev',
  'https://twica-preview.tsubasa-azumagakito.workers.dev',
])

const LOCAL_DEV_ORIGINS = new Set([
  'http://localhost:8787',
  'http://localhost:3000',
  'http://127.0.0.1:8787',
  'http://127.0.0.1:3000',
])

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
 * リクエストから正規化された許可 origin を解決する。
 * 許可 origin（ローカル開発 / workers.dev）に一致する host のみ採用し、それ以外は
 * NEXT_PUBLIC_APP_URL の origin を返す（fail-closed）。port を含む完全一致で検証する
 * ため、許可ホストに任意ポートを付けた偽装を拒否する（#836 レビュー指摘）。
 */
export function resolveAllowedOrigin(host: string | null): string {
  const fallbackOrigin = resolveFallbackOrigin()
  if (!host) return fallbackOrigin

  const normalizedHost = host.toLowerCase()
  // ローカル開発は host ヘッダーのみで判定（wrangler dev は http://localhost:8787）。
  // production ビルドでは localhost を許可しない（Host ヘッダ注入の抜け穴を塞ぐ）。
  if (process.env.NODE_ENV !== 'production') {
    const localOrigin = `http://${normalizedHost}`
    if (LOCAL_DEV_ORIGINS.has(localOrigin)) return localOrigin
  }

  // workers.dev は常に https（workers.dev は http を受け付けない）
  if (WORKERS_DEV_ALLOWED_ORIGINS.has(`https://${normalizedHost}`)) {
    return `https://${normalizedHost}`
  }

  // 許可外ホストを無言でフォールバックすると、NEXT_PUBLIC_APP_URL と実配信ホストの
  // ズレに気付けず OAuth が全滅する（#836 レビュー指摘）。warn ログで手掛かりを残す。
  // host は外部入力のため、制御文字を除去し長さを制限してから出力する（ログ汚染対策）。
  const sanitizedHost = host.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128)
  console.warn(`[url-utils] Disallowed host detected, falling back to NEXT_PUBLIC_APP_URL: ${sanitizedHost}`)
  return fallbackOrigin
}

/**
 * リクエストからベースURLを取得する
 * 許可リスト（ローカル開発 / workers.dev）に一致する host のみ採用し、それ以外は
 * NEXT_PUBLIC_APP_URL の origin を返す（fail-closed）。Worker 名変更・ドメイン追加時は
 * WORKERS_DEV_ALLOWED_ORIGINS の更新が必要。
 *
 * @param request - HTTPリクエスト
 * @returns ベースURL（例: http://localhost:8787, https://example.com）
 */
export function getBaseUrl(request: Request): string {
  return resolveAllowedOrigin(request.headers.get('host'))
}
