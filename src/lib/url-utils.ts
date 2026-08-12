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

/**
 * リクエストから正規化された許可 origin を解決する。
 * host ヘッダー + x-forwarded-proto から組み立てた origin が許可リスト
 * （NEXT_PUBLIC_APP_URL / workers.dev / ローカル開発）に完全一致する場合のみ
 * その origin を返し、それ以外は NEXT_PUBLIC_APP_URL の origin を返す。
 * port を含む完全一致で検証するため、許可ホストに任意ポートを付けた偽装を拒否する
 * （#836 レビュー指摘: hostname だけの検証では raw Host / raw proto をそのまま
 * 返してしまい、非 canonical な redirect_uri を生成できる）。
 */
export function resolveAllowedOrigin(
  host: string | null,
  forwardedProto: string | null
): string {
  const fallback = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8787'
  let fallbackOrigin: string
  try {
    fallbackOrigin = new URL(fallback).origin
  } catch {
    // NEXT_PUBLIC_APP_URL が不正な場合はビルド設定ミス。リクエストごとに throw して
    // 全導線を落とすより、ローカル開発のデフォルトへ倒してログで気付けるようにする。
    console.warn('[url-utils] Invalid NEXT_PUBLIC_APP_URL, falling back to localhost:', fallback)
    fallbackOrigin = 'http://localhost:8787'
  }

  // ローカル開発は host ヘッダーのみで判定（wrangler dev は http://localhost:8787）。
  // production ビルドでは localhost を許可しない（Host ヘッダ注入の抜け穴を塞ぐ）。
  if (host && process.env.NODE_ENV !== 'production') {
    const localOrigin = `http://${host.toLowerCase()}`
    if (LOCAL_DEV_ORIGINS.has(localOrigin)) return localOrigin
  }

  // workers.dev は常に https（workers.dev は http を受け付けない）
  if (host) {
    const candidate = `https://${host.toLowerCase()}`
    if (WORKERS_DEV_ALLOWED_ORIGINS.has(candidate)) return candidate
  }

  // NEXT_PUBLIC_APP_URL の origin と一致する場合のみ許可（port も含む完全一致）。
  // x-forwarded-proto が無い場合は https 前提（Cloudflare は本番で https のみ）。
  // 明示的に http が渡された場合は https と一致しないためフォールバックする。
  if (host) {
    const proto = forwardedProto ?? 'https'
    const candidate = `${proto}://${host.toLowerCase()}`
    if (candidate === fallbackOrigin) return candidate
  }

  if (host) {
    // 許可外ホストを無言でフォールバックすると、NEXT_PUBLIC_APP_URL と実配信ホストの
    // ズレに気付けず OAuth が全滅する（#836 レビュー指摘）。warn ログで手掛かりを残す。
    console.warn('[url-utils] Disallowed host detected, falling back to NEXT_PUBLIC_APP_URL:', host)
  }

  return fallbackOrigin
}

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
  const host = request.headers.get('host')
  const forwardedProto = request.headers.get('x-forwarded-proto')
  return resolveAllowedOrigin(host, forwardedProto)
}
