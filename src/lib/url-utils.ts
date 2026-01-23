/**
 * URL関連のユーティリティ関数
 */

/**
 * リクエストからベースURLを取得する
 * 開発環境・プレビュー環境ではリクエストのホストヘッダーから動的に生成
 * 本番環境では NEXT_PUBLIC_APP_URL を使用
 *
 * @param request - HTTPリクエスト
 * @returns ベースURL（例: http://localhost:3000, https://example.com）
 */
export function getBaseUrl(request: Request): string {
  // 本番環境では NEXT_PUBLIC_APP_URL を使用
  // ただし、Vercelのプレビュー環境（VERCEL_ENV === 'preview'）では
  // リクエストのホストから動的に取得する
  // これは、プレビュー環境（preview.twica.bluemoon.works）でOAuth認証の
  // リダイレクトURIが正しく設定されるようにするため
  const isVercelPreview = process.env.VERCEL_ENV === 'preview'

  if (process.env.NODE_ENV === 'production' && !isVercelPreview) {
    return process.env.NEXT_PUBLIC_APP_URL || ''
  }

  // 開発環境・プレビュー環境ではリクエストのホストから動的に取得
  const host = request.headers.get('host')
  if (!host) {
    // フォールバック: NEXT_PUBLIC_APP_URL を使用
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  }

  // プロトコルを判定
  // x-forwarded-proto ヘッダーがあればそれを使用（プロキシ経由の場合）
  // なければホスト名から判定
  const forwardedProto = request.headers.get('x-forwarded-proto')
  let protocol: string

  if (forwardedProto) {
    protocol = forwardedProto
  } else if (host.includes('localhost') || host.includes('127.0.0.1') || host.includes('::1')) {
    protocol = 'http'
  } else {
    // デフォルトは https
    protocol = 'https'
  }

  return `${protocol}://${host}`
}
