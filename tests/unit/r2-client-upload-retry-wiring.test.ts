import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// uploadToR2WithRetry / uploadSoundToR2WithRetry（公開関数）のエンドツーエンドテスト。
//
// 【Issue #982】tests/unit/r2-client-retry-loop.test.ts は共通リトライループ本体
// （withR2UploadRetry）を upload/sleep を注入して直接テストしているが、公開関数
// uploadToR2WithRetry / uploadSoundToR2WithRetry が実際に withR2UploadRetry へ
// 正しく結線されている（fileName/buffer/contentTypeを正しく渡す）ことは、それ単体
// では検証できない（maxRetriesの境界値そのものはr2-client-retry-loop.test.ts側で
// 検証済みなのでここでは繰り返さない）。r2-client.tsは内部でuploadToR2/uploadSoundToR2を
// 同一モジュール内の関数として直接呼ぶため、vi.spyOn等でのモック差し替えは効かない
// （同一モジュール内呼び出しはexportされたbindingを経由しないため）。
//
// そこで2種類のテストで公開関数を実際に実行し、内部の結線を検証する:
// 1. R2バインディング・環境変数がどちらも無い状態（テスト環境のデフォルト）で呼び出し、
//    実際のuploadToR2/uploadSoundToR2が投げる「環境変数が無い」という恒久エラーが
//    1回の試行だけでそのまま返ることを確認する（バックオフ待機が発生しないため高速）。
// 2. @aws-sdk/client-s3をモックし、Issue #976/#977で問題になった「(10001)」エラーを
//    2回返した後に成功するシナリオで、uploadToR2WithRetryが実際にリトライして
//    最終的に成功を返すことを確認する（実際のsetTimeoutを使うため数秒かかる）。
const sendMock = vi.fn()
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}))

describe('uploadToR2WithRetry / uploadSoundToR2WithRetry の結線', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    sendMock.mockReset()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('R2バインディング・環境変数がどちらも無い場合、実際のuploadToR2が投げる恒久エラーを1回の試行で返す', async () => {
    delete process.env.R2_BUCKET_NAME
    process.env.R2_PUBLIC_URL = 'https://example.test'

    const { uploadToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadToR2WithRetry('f.png', Buffer.from('x'), 'image/png', 3)

    expect(result).toEqual({ error: 'Missing R2_BUCKET_NAME environment variable' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('R2バインディング・環境変数がどちらも無い場合、実際のuploadSoundToR2が投げる恒久エラーを1回の試行で返す', async () => {
    delete process.env.R2_SOUND_BUCKET_NAME
    process.env.R2_SOUND_PUBLIC_URL = 'https://example.test'

    const { uploadSoundToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadSoundToR2WithRetry('f.mp3', Buffer.from('x'), 'audio/mpeg', 3)

    expect(result).toEqual({ error: 'Missing R2_SOUND_BUCKET_NAME environment variable' })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('R2固有のInternalError(10001)が2回続いた後に成功すれば、uploadToR2WithRetryは実際にリトライして成功を返す (Issue #976/#977/#980の回帰防止)', async () => {
    process.env.R2_PUBLIC_URL = 'https://example.test'
    process.env.R2_BUCKET_NAME = 'test-bucket'
    process.env.R2_ENDPOINT = 'https://example.r2.test'
    process.env.R2_ACCESS_KEY_ID = 'fake-key'
    process.env.R2_SECRET_ACCESS_KEY = 'fake-secret'
    sendMock
      .mockRejectedValueOnce(new Error('put: We encountered an internal error. Please try again. (10001)'))
      .mockRejectedValueOnce(new Error('put: We encountered an internal error. Please try again. (10001)'))
      .mockResolvedValueOnce({})

    const { uploadToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadToR2WithRetry('f.png', Buffer.from('x'), 'image/png', 3)

    expect(result).toEqual({ url: 'https://example.test/f.png' })
    expect(sendMock).toHaveBeenCalledTimes(3)
    // fileName/contentTypeが最後まで正しく引き継がれてPutObjectCommandへ渡っていることを確認する
    // （リトライのたびに引数を取り違えていないことの検証）
    const lastCallInput = sendMock.mock.calls[2][0].input
    expect(lastCallInput).toMatchObject({ Bucket: 'test-bucket', Key: 'f.png', ContentType: 'image/png' })
  }, 15000)

  it('恒久エラー（AccessDenied）はS3 SDK経由でも1回の試行で打ち切り、リトライしない', async () => {
    process.env.R2_PUBLIC_URL = 'https://example.test'
    process.env.R2_BUCKET_NAME = 'test-bucket'
    process.env.R2_ENDPOINT = 'https://example.r2.test'
    process.env.R2_ACCESS_KEY_ID = 'fake-key'
    process.env.R2_SECRET_ACCESS_KEY = 'fake-secret'
    sendMock.mockRejectedValue(new Error('AccessDenied: invalid credentials'))

    const { uploadToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadToR2WithRetry('f.png', Buffer.from('x'), 'image/png', 3)

    expect(result).toEqual({ error: 'AccessDenied: invalid credentials' })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})
