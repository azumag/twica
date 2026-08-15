export interface R2UploadResult {
  url?: string
  error?: string
}

// Cloudflare R2固有のエラーシグネチャのうち、公式にリトライ推奨とされている一時障害:
// https://developers.cloudflare.com/r2/api/error-codes/
// r2-client.ts（効果音アップロードの一時障害判定）とここで別々に同じ文字列を持つと、
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

export async function retryCloudflareR2Upload<T extends R2UploadResult>(
  upload: () => Promise<T>,
  maxRetries = 2,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  let result = await upload()

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (!result.error || !isTransientCloudflareR2Error(result.error)) {
      return result
    }

    await sleep(2 ** attempt * 500)
    result = await upload()
  }

  return result
}
