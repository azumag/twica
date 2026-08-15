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

// 【Issue #980】以前このファイルは isTransientCloudflareR2Error（判定関数）と
// retryCloudflareR2Upload（二重リトライの原因になった外側リトライラッパー）も
// 提供していたが撤去済み。判定ロジック・リトライループはr2-client.tsの
// isTransientR2Error / withR2UploadRetry に一本化した。経緯・撤去理由の詳細は
// src/lib/r2-client.ts の TRANSIENT_R2_ERROR_PATTERNS のコメントとIssue #980を参照
// （同じ説明をファイル間で重複させない）。ここは CLOUDFLARE_R2_TRANSIENT_MARKERS
// という「何が一時障害か」のデータだけを提供するsingle source of truthとして残す。
