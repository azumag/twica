export interface R2UploadResult {
  url?: string
  error?: string
}

const CLOUDFLARE_R2_TRANSIENT_MARKERS = [
  '(10043)',
  // R2の内部エラー(InternalError)。Cloudflare側の一時障害で、
  // メッセージは "We encountered an internal error. Please try again. (10001)"
  // 固定文言のため、将来コードが変わっても拾えるようフレーズでも判定する (Issue #976, #977)
  '(10001)',
  'we encountered an internal error',
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
