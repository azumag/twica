import { NextResponse } from 'next/server'
import { SECURITY_HEADERS } from './constants'

/**
 * script-src / connect-src 以外は全 variant 共通のため、1箇所の表から組み立てる
 * （文字列の三重複による乖離を防ぐ）。
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
    // overlay は同一オリジン iframe 埋め込みのみ許可（X-Frame-Options SAMEORIGIN と
    // 同じ意味。frame-ancestors は CSP ヘッダーのみ有効で meta では無効）。
    "frame-ancestors 'self'",
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
    // CSP Level 2 対応ブラウザは nonce を外部スクリプトにも適用するため、beacon に
    // nonce を渡している以上（layout.tsx）読み込める。beacon だけが落ちるのは
    // nonce 自体を解さない CSP Level 1 のみ。影響はアナリティクス欠損のみで許容する。
    const scriptSrc = nonce
      ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
      : `'self' https://static.cloudflareinsights.com`
    return composeCsp(scriptSrc, "'self' https: wss:")
  }
  // 開発環境でも nonce 経路を再現できるよう、nonce があれば script-src へ含める
  // （Next.js fast refresh 用の unsafe-eval / インライン用の unsafe-inline は維持）。
  // 注記: CSP 仕様上 nonce-source があると script-src の 'unsafe-inline' は無視される
  // ため、dev の nonce あり経路は実質 nonce ベースになる（Next.js が nonce を
  // 伝播するため実害はない。コメントは誤解を避けるための補足）。
  const scriptSrc = nonce
    ? `'self' 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com`
    : `'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com`
  return composeCsp(scriptSrc, "'self' https: localhost:* wss:")
}

/**
 * Set security headers on response
 * レスポンスにセキュリティヘッダーを設定
 * @param response - NextResponse object to modify
 * @param options - pathname（route 別ヘッダー用）と生成済み CSP 文字列。
 *   csp 省略時は buildCsp() で nonce なしを組み立てる。middleware はリクエストごとに
 *   1 回だけ buildCsp(nonce) を呼び、request / response 両ヘッダーへ同じ csp を渡す
 *   （nonce 契約）。引数をオブジェクトにしたのは、csp の位置に nonce 文字列を渡す
 *   誤用をコンパイラで弾くため（string のままの第3引数は意味の取り違えが検出不能）。
 */
export function setSecurityHeaders(
  response: NextResponse,
  options?: { pathname?: string; csp?: string }
): NextResponse {
  const { pathname, csp } = options ?? {}
  response.headers.set('X-Content-Type-Options', SECURITY_HEADERS.X_CONTENT_TYPE_OPTIONS)

  // overlay ルートは同一オリジンからの iframe 埋め込みを許可（プレビュー機能用）
  // Allow same-origin iframe embedding for overlay routes (for preview functionality)
  if (pathname?.startsWith('/overlay')) {
    response.headers.set('X-Frame-Options', 'SAMEORIGIN')
  } else {
    response.headers.set('X-Frame-Options', SECURITY_HEADERS.X_FRAME_OPTIONS)
  }

  // 空文字列の csp は「無制限 CSP」と同義になるため || でフォールバックする
  // （?? だと空文字が素通しになり fail-open）。
  response.headers.set('Content-Security-Policy', csp || buildCsp())

  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', SECURITY_HEADERS.HSTS)
  }

  return response
}
