// server-only logger（DB記録あり）を使う。この関数はRoute Handler経由でのみ呼ばれる。
import { logger } from './logger.server'

export interface R2UploadResult {
  url?: string
  error?: string
}

const CLOUDFLARE_R2_TRANSIENT_MARKERS = [
  '(10043)',
  // R2の内部エラー(InternalError)。"put: We encountered an internal error.
  // Please try again. (10001)" という固定コードで返る一時障害 (Issue #976, #977)
  '(10001)',
  'cloudflarestatus.com',
  'contact customer support',
]

/**
 * @param message - R2アップロード（uploadToR2WithRetry/uploadSoundToR2WithRetry）が
 *   返すエラーメッセージを想定。他ソースのエラーメッセージに対して呼ぶと、
 *   '(10001)'のような部分一致が無関係な文脈で誤検知しうるため使わないこと。
 */
export function isTransientCloudflareR2Error(message: string): boolean {
  const normalized = message.toLowerCase()
  return CLOUDFLARE_R2_TRANSIENT_MARKERS.some((marker) => normalized.includes(marker))
}

export async function retryCloudflareR2Upload<T extends R2UploadResult>(
  upload: () => Promise<T>,
  maxRetries = 2,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  // ログの試行回数表記は内側uploadToR2WithRetry（src/lib/r2-client.ts）と揃え、
  // 「n回目/最大試行数」の総試行数ベースにする（障害調査で両ログを突き合わせやすくするため）
  const totalAttempts = maxRetries + 1
  let result = await upload()

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (!result.error || !isTransientCloudflareR2Error(result.error)) {
      return result
    }

    // 一時障害の再試行が発生したことを記録する。成功で終わっても再試行が
    // 起きた事実がログに残らないと、#976/#977のような障害の再発を運用で
    // 検知できない（内側のuploadToR2WithRetry等は独自にlogger.warnを出すが、
    // この外側レイヤーは無音だったため追加）
    logger.warn(
      `[R2] Transient error, retrying (attempt ${attempt + 1}/${totalAttempts}):`,
      result.error
    )

    await sleep(2 ** attempt * 500)
    result = await upload()
  }

  // 再試行を使い切ってなお一時障害が続くケース。route側のhandleBlobErrorが
  // errorsテーブルへ記録するため障害情報自体は失われないが、「リトライしても
  // 直らなかった」という事実はここでしか判別できないため明示的に警告する
  if (result.error && isTransientCloudflareR2Error(result.error)) {
    logger.warn(`[R2] Transient error persisted after ${totalAttempts} attempts:`, result.error)
  }

  return result
}
