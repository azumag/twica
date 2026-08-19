import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// uploadToR2WithRetry / uploadSoundToR2WithRetry（公開関数）のエンドツーエンドテスト。
//
// 【Issue #982】tests/unit/r2-client-retry-loop.test.ts は共通リトライループ本体
// （withR2UploadRetry）を upload/sleep を注入して直接テストしているが、公開関数
// uploadToR2WithRetry / uploadSoundToR2WithRetry が実際に withR2UploadRetry へ
// 正しく結線されている（fileName/buffer/contentType、S3Client の endpoint/credentials を
// 正しく渡す）ことは、それ単体では検証できない（maxRetriesの境界値そのものは
// r2-client-retry-loop.test.ts側で検証済みなのでここでは繰り返さない）。r2-client.tsは
// 内部でuploadToR2/uploadSoundToR2を同一モジュール内の関数として直接呼ぶため、
// vi.spyOn等でのモック差し替えは効かない（同一モジュール内呼び出しはexportされた
// bindingを経由しないため）。
//
// そこで3種類のテストで公開関数を実際に実行し、内部の結線を検証する:
// 1. R2バインディング・環境変数がどちらも無い状態（下記の明示的なモックで再現）で呼び出し、
//    実際のuploadToR2/uploadSoundToR2が投げる「環境変数が無い」という恒久エラーが
//    1回の試行だけでそのまま返ることを確認する（画像・効果音の2件）。
// 2. @aws-sdk/client-s3をモックし、Issue #976/#977で問題になった「(10001)」エラーを
//    2回返した後に成功するシナリオで、uploadToR2WithRetry/uploadSoundToR2WithRetryが
//    実際にリトライして最終的に成功を返すことを確認する（画像・効果音の2件。
//    PutObjectCommandへ渡るBucket/Key/Body/ContentTypeと、各試行のS3Clientへ渡る
//    endpoint/credentialsを検証し、リトライ中に引数や資格情報を取り違えていないことを確認する）。
// 3. 恒久エラー（AccessDenied）はS3 SDK経由でも1回の試行で打ち切り、リトライ
//    しないことを確認する。
//
// なお、リトライ成功ケースの指数バックオフは vi.useFakeTimers() + runAllTimersAsync() で
// 進め、実setTimeoutによる待機時間をテスト実行時間に乗せない。待機値へ依存しない
// ため、バックオフの基数や試行回数が変わってもアサーションは壊れない。
//
// @opennextjs/cloudflareはgetR2Bindingが動的importする（src/lib/r2-client.ts）。
// モックしないと、Node.js実行環境（Vitest）でgetCloudflareContext({async:true})が
// wranglerのgetPlatformProxy()へフォールバックしてworkerdを起動しうる（バージョンや
// 実行環境によって挙動が変わり得る、暗黙の外部依存）。他のgetCloudflareContext到達
// テスト全て（tests/unit/db-client.test.ts等）と同じ規約に合わせ、常にバインディング
// 不在（空のenv）を明示的にモックすることで、このテストの前提を固定する。
const mocks = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getCloudflareContext: vi.fn(async () => ({ env: {} })),
  // S3Client へ渡る config（endpoint / credentials）を捕捉し、画像・効果音の
  // 資格情報分岐が正しいキー名を選ぶことを直接検証するために保持する。
  s3ClientConfigs: [] as Array<Record<string, unknown>>,
}))
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation((config: Record<string, unknown>) => {
    mocks.s3ClientConfigs.push(config)
    return { send: mocks.sendMock }
  }),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}))
const sendMock = mocks.sendMock
const s3ClientConfigs = mocks.s3ClientConfigs

// 画像・効果音それぞれに必要な env をまとめてスタブする。各テストで vi.stubEnv
// を繰り返すと画像/効果音の資格情報分岐の是非が読みにくくなるためヘルパへ抽出する。
function stubImageEnv(): void {
  vi.stubEnv('R2_PUBLIC_URL', 'https://example.test')
  vi.stubEnv('R2_BUCKET_NAME', 'test-bucket')
  vi.stubEnv('R2_ENDPOINT', 'https://example.r2.test')
  vi.stubEnv('R2_ACCESS_KEY_ID', 'image-key')
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'image-secret')
  // 効果音側の資格情報が環境に存在しても、画像分岐が誤って選ばないことを固定する。
  vi.stubEnv('R2_SOUND_ACCESS_KEY_ID', undefined)
  vi.stubEnv('R2_SOUND_SECRET_ACCESS_KEY', undefined)
}

function stubSoundEnv(): void {
  vi.stubEnv('R2_SOUND_PUBLIC_URL', 'https://sounds.example.test')
  vi.stubEnv('R2_SOUND_BUCKET_NAME', 'sound-bucket')
  vi.stubEnv('R2_ENDPOINT', 'https://example.r2.test')
  vi.stubEnv('R2_SOUND_ACCESS_KEY_ID', 'sound-key')
  vi.stubEnv('R2_SOUND_SECRET_ACCESS_KEY', 'sound-secret')
  // 画像側の資格情報が環境に存在しても、sound分岐が誤って選ばないことを固定する。
  vi.stubEnv('R2_ACCESS_KEY_ID', undefined)
  vi.stubEnv('R2_SECRET_ACCESS_KEY', undefined)
}

describe('uploadToR2WithRetry / uploadSoundToR2WithRetry の結線', () => {
  beforeAll(async () => {
    // #1017: r2-client.ts が動的 import する2モジュールを fake timers 有効化前に
    // 一度解決しておく。先行テストの実行順に依存せず、runAllTimersAsync() が動的
    // import の完了前に抜けて pending が30秒タイムアウトする flaky を防ぐ。
    await Promise.all([import('@aws-sdk/client-s3'), import('@opennextjs/cloudflare')])
  })

  beforeEach(() => {
    sendMock.mockReset()
    mocks.getCloudflareContext.mockClear()
    s3ClientConfigs.length = 0
  })

  afterEach(() => {
    // 環境変数はテストごとに vi.stubEnv で設定・削除し、ここで必ず元へ戻す。
    vi.unstubAllEnvs()
    // リトライ系テストは fake timers を使うため、後続テストへ影響を残さない。
    vi.useRealTimers()
  })

  it('R2バインディング・環境変数がどちらも無い場合、実際のuploadToR2が投げる恒久エラーを1回の試行で返す', async () => {
    // R2_BUCKET_NAME は「未設定」を再現するため明示的に削除する
    vi.stubEnv('R2_BUCKET_NAME', undefined)
    vi.stubEnv('R2_PUBLIC_URL', 'https://example.test')

    const { uploadToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadToR2WithRetry('f.png', Buffer.from('x'), 'image/png', 3)

    expect(result).toEqual({ error: 'Missing R2_BUCKET_NAME environment variable' })
    expect(sendMock).not.toHaveBeenCalled()
    // getR2Binding() は1試行につき1回だけ到達するため、恒久エラーを誤って
    // transient 扱いしてリトライする回帰を、タイマーの有無ではなく試行回数で直接検知する。
    expect(mocks.getCloudflareContext).toHaveBeenCalledTimes(1)
  })

  it('R2バインディング・環境変数がどちらも無い場合、実際のuploadSoundToR2が投げる恒久エラーを1回の試行で返す', async () => {
    vi.stubEnv('R2_SOUND_BUCKET_NAME', undefined)
    vi.stubEnv('R2_SOUND_PUBLIC_URL', 'https://example.test')

    const { uploadSoundToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadSoundToR2WithRetry('f.mp3', Buffer.from('x'), 'audio/mpeg', 3)

    expect(result).toEqual({ error: 'Missing R2_SOUND_BUCKET_NAME environment variable' })
    expect(sendMock).not.toHaveBeenCalled()
    expect(mocks.getCloudflareContext).toHaveBeenCalledTimes(1)
  })

  it('R2固有のInternalError(10001)が2回続いた後に成功すれば、uploadToR2WithRetryは実際にリトライして成功を返す (Issue #976/#977/#980の回帰防止)', async () => {
    vi.useFakeTimers()
    stubImageEnv()
    sendMock
      .mockRejectedValueOnce(new Error('put: We encountered an internal error. Please try again. (10001)'))
      .mockRejectedValueOnce(new Error('put: We encountered an internal error. Please try again. (10001)'))
      .mockResolvedValueOnce({})

    const { uploadToR2WithRetry } = await import('@/lib/r2-client')
    const pending = uploadToR2WithRetry('f.png', Buffer.from('img'), 'image/png', 3)
    // 保留中の指数バックオフを実時間で待たずに全て進める
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result).toEqual({ url: 'https://example.test/f.png' })
    expect(sendMock).toHaveBeenCalledTimes(3)
    // 全試行の入力が常に正しいことを確認する（リトライのたびに引数やbufferを
    // 取り違えていないことの検証。最終試行だけを見ると途中の取り違えが素通りする）
    for (const call of sendMock.mock.calls) {
      const input = call[0].input
      expect(input).toMatchObject({ Bucket: 'test-bucket', Key: 'f.png', ContentType: 'image/png' })
      expect(input.Body).toEqual(Buffer.from('img'))
    }
    // S3Client は試行ごとに生成される。先頭だけでなく3試行すべてが画像用の
    // endpoint / credentials を受け取ることを固定し、途中試行だけの取り違えも検知する。
    expect(s3ClientConfigs).toHaveLength(3)
    for (const config of s3ClientConfigs) {
      expect(config).toEqual(
        expect.objectContaining({
          region: 'auto',
          endpoint: 'https://example.r2.test',
          credentials: { accessKeyId: 'image-key', secretAccessKey: 'image-secret' },
        }),
      )
    }
  })

  it('効果音側もR2固有のInternalError(10001)が2回続いた後に成功すれば、uploadSoundToR2WithRetryはリトライして成功し、sound用のenvとURLを使う', async () => {
    vi.useFakeTimers()
    stubSoundEnv()
    sendMock
      .mockRejectedValueOnce(new Error('put: We encountered an internal error. Please try again. (10001)'))
      .mockRejectedValueOnce(new Error('put: We encountered an internal error. Please try again. (10001)'))
      .mockResolvedValueOnce({})

    const { uploadSoundToR2WithRetry } = await import('@/lib/r2-client')
    const pending = uploadSoundToR2WithRetry('f.mp3', Buffer.from('snd'), 'audio/mpeg', 3)
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result).toEqual({ url: 'https://sounds.example.test/f.mp3' })
    expect(sendMock).toHaveBeenCalledTimes(3)
    for (const call of sendMock.mock.calls) {
      const input = call[0].input
      expect(input).toMatchObject({ Bucket: 'sound-bucket', Key: 'f.mp3', ContentType: 'audio/mpeg' })
      expect(input.Body).toEqual(Buffer.from('snd'))
    }
    // sound側も全試行を検証し、画像用credentialsへの誤フォールバックを見逃さない。
    expect(s3ClientConfigs).toHaveLength(3)
    for (const config of s3ClientConfigs) {
      expect(config).toEqual(
        expect.objectContaining({
          region: 'auto',
          endpoint: 'https://example.r2.test',
          credentials: { accessKeyId: 'sound-key', secretAccessKey: 'sound-secret' },
        }),
      )
    }
  })

  it('恒久エラー（AccessDenied）はS3 SDK経由でも1回の試行で打ち切り、リトライしない', async () => {
    stubImageEnv()
    sendMock.mockRejectedValue(new Error('AccessDenied: invalid credentials'))

    const { uploadToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadToR2WithRetry('f.png', Buffer.from('x'), 'image/png', 3)

    expect(result).toEqual({ error: 'AccessDenied: invalid credentials' })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})
