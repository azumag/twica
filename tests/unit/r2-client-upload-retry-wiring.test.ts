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
// 実際に指数バックオフを通るリトライ成功ケースだけは vi.useFakeTimers() +
// runAllTimersAsync() で進め、実setTimeoutによる待機をテスト時間へ乗せない。
// 恒久エラーケースは通常タイマーを登録しないため real timers のまま実行し、試行回数の
// アサーションで1回打ち切りを固定する。将来、恒久エラーが誤ってtransient判定へ回帰した
// 場合は1s+2s+4sの最大約7秒を実時間で待ってから失敗するが、現行testTimeout（30秒）内で
// 確実に検知できるため、通常系へ不要なfake timers前提を増やさない簡潔性を優先する。
// withR2UploadRetry のバックオフ式や既定リトライ回数を変更する場合は、この30秒以内という
// 前提も併せて見直し、必要なら恒久エラー系をfake timers化するかtestTimeoutを再設定する。
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
const getCloudflareContextMock = mocks.getCloudflareContext
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

// maxRetries は「初回試行後に許容する再試行回数」で、fixture の総試行回数とは別契約。
const MAX_RETRIES = 3
// 1回だけ試行 = リトライなし。
const SINGLE_ATTEMPT_NO_RETRY = 1
const TRANSIENT_FAILURES_BEFORE_SUCCESS = 2
const RETRY_SUCCESS_ATTEMPTS = TRANSIENT_FAILURES_BEFORE_SUCCESS + 1
const R2_INTERNAL_ERROR = 'put: We encountered an internal error. Please try again. (10001)'

function mockTransientFailuresThenSuccess(): void {
  for (let attempt = 0; attempt < TRANSIENT_FAILURES_BEFORE_SUCCESS; attempt += 1) {
    sendMock.mockRejectedValueOnce(new Error(R2_INTERNAL_ERROR))
  }
  sendMock.mockResolvedValueOnce({})
}

function expectAllAttemptsUsedConfig(expectedAttempts: number, expectedConfig: Record<string, unknown>): void {
  // PR #1030で呼び出し側にあった送信試行数のassertをこのヘルパへ集約したため、
  // 「期待回数だけ試行し、その各試行で期待configを使う」までを1つの契約として検証する。
  // 件数契約を呼び出し側と二重管理せず、ヘルパ名と責務を一致させる。
  expect(sendMock).toHaveBeenCalledTimes(expectedAttempts)
  expect(s3ClientConfigs).toHaveLength(expectedAttempts)
  for (const config of s3ClientConfigs) {
    expect(config).toEqual(expect.objectContaining(expectedConfig))
  }
}

describe('uploadToR2WithRetry / uploadSoundToR2WithRetry の結線', () => {
  beforeAll(async () => {
    // #1017/#1024: upload経路でawaitされる2つの動的importをfake timers有効化前に
    // 一度解決しておく。先行テストの実行順に依存せず、runAllTimersAsync() が動的
    // importの完了前に抜けてpendingが30秒タイムアウトするflakyを防ぐ。
    // logger側にも動的importはあるが、現状はfire-and-forgetでupload/retryの待機対象に
    // ならないためここではpre-warmしない。将来await化する場合は対象を再評価する。
    await Promise.all([import('@aws-sdk/client-s3'), import('@opennextjs/cloudflare')])
  })

  beforeEach(() => {
    sendMock.mockReset()
    getCloudflareContextMock.mockClear()
    s3ClientConfigs.length = 0
  })

  afterEach(() => {
    // 環境変数はテストごとに vi.stubEnv で設定・削除し、ここで必ず元へ戻す。
    vi.unstubAllEnvs()
    // リトライ成功テストは fake timers を使うため、後続テストへ影響を残さない。
    vi.useRealTimers()
  })

  it('R2バインディング・環境変数がどちらも無い場合、実際のuploadToR2が投げる恒久エラーを1回の試行で返す', async () => {
    // R2_BUCKET_NAME は「未設定」を再現するため明示的に削除する
    vi.stubEnv('R2_BUCKET_NAME', undefined)
    vi.stubEnv('R2_PUBLIC_URL', 'https://example.test')

    const { uploadToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadToR2WithRetry('f.png', Buffer.from('x'), 'image/png', MAX_RETRIES)

    expect(result).toEqual({ error: 'Missing R2_BUCKET_NAME environment variable' })
    expect(sendMock).not.toHaveBeenCalled()
    // getR2Binding() は現行実装で1試行につき1回だけ到達するため、恒久エラーを誤って
    // transient 扱いしてリトライする回帰を試行回数として直接検知する。将来
    // getCloudflareContextをメモ化する場合は、この代理指標を別の試行回数指標へ置き換える。
    expect(getCloudflareContextMock).toHaveBeenCalledTimes(1)
  })

  it('R2バインディング・環境変数がどちらも無い場合、実際のuploadSoundToR2が投げる恒久エラーを1回の試行で返す', async () => {
    vi.stubEnv('R2_SOUND_BUCKET_NAME', undefined)
    vi.stubEnv('R2_SOUND_PUBLIC_URL', 'https://example.test')

    const { uploadSoundToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadSoundToR2WithRetry('f.mp3', Buffer.from('x'), 'audio/mpeg', MAX_RETRIES)

    expect(result).toEqual({ error: 'Missing R2_SOUND_BUCKET_NAME environment variable' })
    expect(sendMock).not.toHaveBeenCalled()
    expect(getCloudflareContextMock).toHaveBeenCalledTimes(1)
  })

  it('R2固有のInternalError(10001)が2回続いた後に成功すれば、uploadToR2WithRetryは実際にリトライして成功を返す (Issue #976/#977/#980の回帰防止)', async () => {
    stubImageEnv()
    mockTransientFailuresThenSuccess()

    const { uploadToR2WithRetry } = await import('@/lib/r2-client')
    vi.useFakeTimers()
    const pending = uploadToR2WithRetry('f.png', Buffer.from('img'), 'image/png', MAX_RETRIES)
    // 保留中の指数バックオフを実時間で待たずに全て進める
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result).toEqual({ url: 'https://example.test/f.png' })
    // 全試行の入力が常に正しいことを確認する（リトライのたびに引数やbufferを
    // 取り違えていないことの検証。最終試行だけを見ると途中の取り違えが素通りする）
    for (const call of sendMock.mock.calls) {
      const input = call[0].input
      expect(input).toMatchObject({ Bucket: 'test-bucket', Key: 'f.png', ContentType: 'image/png' })
      expect(input.Body).toEqual(Buffer.from('img'))
    }
    expectAllAttemptsUsedConfig(RETRY_SUCCESS_ATTEMPTS, {
      region: 'auto',
      endpoint: 'https://example.r2.test',
      credentials: { accessKeyId: 'image-key', secretAccessKey: 'image-secret' },
    })
  })

  it('効果音側もR2固有のInternalError(10001)が2回続いた後に成功すれば、uploadSoundToR2WithRetryはリトライして成功し、sound用のenvとURLを使う', async () => {
    stubSoundEnv()
    mockTransientFailuresThenSuccess()

    const { uploadSoundToR2WithRetry } = await import('@/lib/r2-client')
    vi.useFakeTimers()
    const pending = uploadSoundToR2WithRetry('f.mp3', Buffer.from('snd'), 'audio/mpeg', MAX_RETRIES)
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result).toEqual({ url: 'https://sounds.example.test/f.mp3' })
    for (const call of sendMock.mock.calls) {
      const input = call[0].input
      expect(input).toMatchObject({ Bucket: 'sound-bucket', Key: 'f.mp3', ContentType: 'audio/mpeg' })
      expect(input.Body).toEqual(Buffer.from('snd'))
    }
    expectAllAttemptsUsedConfig(RETRY_SUCCESS_ATTEMPTS, {
      region: 'auto',
      endpoint: 'https://example.r2.test',
      credentials: { accessKeyId: 'sound-key', secretAccessKey: 'sound-secret' },
    })
  })

  it('恒久エラー（AccessDenied）はS3 SDK経由でも1回の試行で打ち切り、リトライしない', async () => {
    stubImageEnv()
    sendMock.mockRejectedValue(new Error('AccessDenied: invalid credentials'))

    const { uploadToR2WithRetry } = await import('@/lib/r2-client')
    const result = await uploadToR2WithRetry('f.png', Buffer.from('x'), 'image/png', MAX_RETRIES)

    expect(result).toEqual({ error: 'AccessDenied: invalid credentials' })
    expectAllAttemptsUsedConfig(SINGLE_ATTEMPT_NO_RETRY, {
      region: 'auto',
      endpoint: 'https://example.r2.test',
      credentials: { accessKeyId: 'image-key', secretAccessKey: 'image-secret' },
    })
  })
})
