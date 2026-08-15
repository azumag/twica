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

// 【Issue #980】このモジュールは以前 isTransientCloudflareR2Error（一時障害判定の関数版）と
// retryCloudflareR2Upload（それを使うリトライラッパー）も提供しており、
// src/app/api/upload/route.ts が r2-client.ts の uploadToR2WithRetry
// （それ自体が独立したリトライループを持つ）をさらにこれで二重に包んでいた。
// CLOUDFLARE_R2_TRANSIENT_MARKERS 該当エラーは両方の層がリトライ対象と判定するため、
// 最悪ケースで試行回数・待ち時間が約3倍（4回→12回・約22秒）に肥大化しうる、
// 明示的な上限のないリトライ構成になっていた。
// 再試行はr2-client.ts側の1ループに一本化し、判定関数もr2-client.tsのisTransientR2Errorに
// 統合した（この2つを別々に持つと、この一覧を判定に使うロジックが2箇所に分裂し、
// 今回の教訓に反する）。ここは CLOUDFLARE_R2_TRANSIENT_MARKERS という
// 「何が一時障害か」のデータだけを提供するsingle source of truthとして残す。
