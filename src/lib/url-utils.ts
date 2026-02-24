/**
 * URL関連のユーティリティ関数
 */

/**
 * リクエストからベースURLを取得する
 * リクエストの host ヘッダーから動的に生成する。
 * host ヘッダーが取得できない場合は NEXT_PUBLIC_APP_URL にフォールバック。
 *
 * Cloudflare Workers 環境では NEXT_PUBLIC_* 変数はビルド時にインライン化されるため、
 * ランタイムのシークレットで上書きできない。そのためリクエストヘッダーから
 * 動的に取得することで、プレビュー環境・本番環境を問わず正しいURLを返す。
 *
 * @param request - HTTPリクエスト
 * @returns ベースURL（例: http://localhost:8787, https://example.com）
 */
export function getBaseUrl(request: Request): string {
  // リクエストの host ヘッダーから動的に取得
  // Cloudflare Workers / Vercel いずれの環境でも正しく動作する
  const host = request.headers.get('host')
  if (!host) {
    // フォールバック: NEXT_PUBLIC_APP_URL を使用
    // Cloudflare Workers のローカル開発サーバーはポート 8787 を使用
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8787'
  }

  // プロトコルを判定
  // x-forwarded-proto ヘッダーがあればそれを使用（プロキシ経由の場合）
  // なければホスト名から判定
  const forwardedProto = request.headers.get('x-forwarded-proto')
  let protocol: string

  if (host.includes('localhost') || host.includes('127.0.0.1') || host.includes('::1')) {
    // ローカル開発環境は常に HTTP を使用
    // wrangler dev が内部的に x-forwarded-proto: https を設定するため、
    // localhost チェックを x-forwarded-proto より優先しないと
    // redirect_uri が https://localhost:8787/... になりブラウザが接続できない
    protocol = 'http'
  } else if (forwardedProto) {
    protocol = forwardedProto
  } else {
    // デフォルトは https
    protocol = 'https'
  }

  return `${protocol}://${host}`
}
