import { NextResponse } from 'next/server'
import { SECURITY_HEADERS } from './constants'

/**
 * script-src / connect-src 以外は全 variant 共通のため、1箇所の表から組み立てる
 * （#944 レビュー指摘: 文字列の三重複による乖離を防ぐ）。
 */
function composeCsp(scriptSrc: string, connectSrc: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "media-src 'self' https:",
    `connect-src ${connectSrc}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ') + ';'
}

/**
 * nonce 付き CSP を組み立てる（#836 項目5）。
 *
 * nonce がある場合（middleware がリクエストごとに発行）:
 *   `'self' 'nonce-<nonce>' 'strict-dynamic'`
 *   - 'strict-dynamic' により、nonce 付きスクリプトから読み込まれる子スクリプトも
 *     許可される（Next.js の動的チャンク読み込みを壊さない）。
 *   - CSP Level 3 では 'strict-dynamic' が存在すると 'self' とホストソースは
 *     無視されるため、Cloudflare Insights beacon の許可は nonce 付きスクリプト
 *     からの動的読み込み（伝播トラスト）に依存する（host-source は書かない）。
 * nonce がない場合（maintenance block / invalid streamer 等の早期 return 経路）:
 *   'unsafe-inline' は付けず、strict-dynamic も無いため host-source は有効
 *   （JSON エラー応答はスクリプトを含まず実害なし）。
 */
export function buildCsp(nonce?: string): string {
  const isProduction = process.env.NODE_ENV === 'production'
  if (isProduction) {
    // strict-dynamic 非対応ブラウザ（旧 Safari 等）ではトークンが無視され
    // `'self' 'nonce-…'` として評価されるため、static.cloudflareinsights.com の
    // beacon だけが読めなくなる。影響はアナリティクス欠損のみで許容する
    // （#944 レビュー任意指摘。判断根拠として nonce 分岐の直近に残す）。
    const scriptSrc = nonce
      ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
      : `'self' https://static.cloudflareinsights.com`
    return composeCsp(scriptSrc, "'self' https: wss:")
  }
  // 開発環境でも nonce 経路を再現できるよう、nonce があれば script-src へ含める
  // （Next.js fast refresh 用の unsafe-eval / インライン用の unsafe-inline は維持）。
  const scriptSrc = nonce
    ? `'self' 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com`
    : `'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com`
  return composeCsp(scriptSrc, "'self' https: localhost:* wss:")
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
  nonce?: string,
  csp?: string
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

  response.headers.set('Content-Security-Policy', csp ?? buildCsp(nonce))

  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', SECURITY_HEADERS.HSTS)
  }

  return response
}
