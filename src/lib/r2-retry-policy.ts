// Cloudflare R2固有のエラーシグネチャのうち、公式にリトライ推奨とされている一時障害:
// https://developers.cloudflare.com/r2/api/error-codes/
// r2-client.ts（画像・効果音共通のアップロードリトライ）とここで別々に同じ文字列を持つと、
// 一方だけ更新漏れが起きて今回のバグ（10001が片方のリストにしか無かった）が再発するため、
// このマーカー一覧を単一の情報源としてexportし、r2-client.ts側からimportして使う。
export const CLOUDFLARE_R2_TRANSIENT_MARKERS = [
  // 10001: InternalError (HTTP 500)。
  // 未登録だったため本番のR2アップロード失敗が即座にエラー化していた (Issue #976, #977)。
  '(10001)',
  // 10043: ServiceUnavailable (HTTP 503)。
  '(10043)',
  'cloudflarestatus.com',
  'contact customer support',
]

export function isTransientCloudflareR2Error(message: string): boolean {
  const normalized = message.toLowerCase()
  return CLOUDFLARE_R2_TRANSIENT_MARKERS.some((marker) => normalized.includes(marker))
}

// 【Issue #980】このモジュールは以前 retryCloudflareR2Upload（R2UploadResultを返す関数を
// ラップして再試行する汎用ヘルパー）も提供しており、src/app/api/upload/route.ts が
// r2-client.ts の uploadToR2WithRetry（それ自体が独立したリトライループを持つ）をさらに
// これで二重に包んでいた。CLOUDFLARE_R2_TRANSIENT_MARKERS 該当エラーは両方の層が
// リトライ対象と判定するため、最悪ケースで試行回数・待ち時間が約3倍（4回→12回・約22秒）に
// 肥大化しうる、明示的な上限のないリトライ構成になっていた。
// 再試行はr2-client.ts側の1ループに一本化し、ここは「何が一時障害か」の判定
// （CLOUDFLARE_R2_TRANSIENT_MARKERS / isTransientCloudflareR2Error）だけを提供する
// single source of truthとして残す。retryCloudflareR2Uploadは撤去済み。
