import { NextResponse } from 'next/server'
import { SECURITY_HEADERS } from './constants'

/**
 * CSP の script-src を nonce 付きで組み立てる（#836 項目5）。
 *
 * nonce がある場合（middleware がリクエストごとに発行）:
 *   `'self' 'nonce-<nonce>' 'strict-dynamic' https://static.cloudflareinsights.com`
 *   - 'strict-dynamic' により、nonce 付きスクリプトから読み込まれる子スクリプトも
 *     許可される（Next.js の動的チャンク読み込みを壊さない）。
 *   - 外部ホスト（Cloudflare Insights beacon）は明示的に残す（nonce 属性付き
 *     Script コンポーネントで読み込まれるため、strict-dynamic 下でも問題ない）。
 * nonce がない場合（middleware を通らない直接呼び出し・エラー応答のフォールバック）:
 *   従来どおり 'unsafe-inline' を残す。HTML を返す通常経路は必ず middleware を
 *   通るため、実運用でこのフォールバックが使われるのは JSON エラー応答のみで、
 *   スクリプトを含まないため実害はない。
 */
function buildScriptSrcCsp(nonce: string | undefined): string {
  if (nonce) {
    return `'self' 'nonce-${nonce}' 'strict-dynamic' https://static.cloudflareinsights.com`
  }
  return `'self' 'unsafe-inline' https://static.cloudflareinsights.com`
}

/** nonce 付き CSP を組み立てる（開発環境は従来どおり unsafe-eval を許可）。 */
export function buildCsp(nonce?: string): string {
  const isProduction = process.env.NODE_ENV === 'production'
  if (isProduction) {
    return `default-src 'self'; base-uri 'self'; script-src ${buildScriptSrcCsp(nonce)}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' https:; connect-src 'self' https: wss:; font-src 'self' data:; worker-src 'self' blob:;`
  }
  return SECURITY_HEADERS.CSP_DEVELOPMENT
}

/**
 * Set security headers on response
 * レスポンスにセキュリティヘッダーを設定
 * @param response - NextResponse object to modify
 * @param pathname - Request pathname (optional, used for route-specific headers)
 * @param nonce - CSP nonce (optional, issued by middleware per request, #836)
 */
export function setSecurityHeaders(
  response: NextResponse,
  pathname?: string,
  nonce?: string
): NextResponse {
  response.headers.set('X-Content-Type-Options', SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS)

  // overlay ルートは同一オリジンからの iframe 埋め込みを許可（プレビュー機能用）
  // Allow same-origin iframe embedding for overlay routes (for preview functionality)
  if (pathname?.startsWith('/overlay')) {
    response.headers.set('X-Frame-Options', 'SAMEORIGIN')
  } else {
    response.headers.set('X-Frame-Options', SECURITY_HEADERS.X_FRAME_OPTIONS)
  }

  response.headers.set('X-XSS-Protection', SECURITY_HEADERS.X_XSS_PROTECTION)

  response.headers.set('Content-Security-Policy', buildCsp(nonce))

  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', SECURITY_HEADERS.HSTS)
  }

  return response
}
