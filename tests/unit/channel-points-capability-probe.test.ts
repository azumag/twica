import { beforeEach, describe, expect, it, vi } from 'vitest'

// #788/#789: probeChannelPointsCapability() は非Affiliate配信者を含む「Channel Points
// が実際に利用可能か」を、報酬を一切作成しない読み取り専用APIコール
// (GET /helix/channel_points/custom_rewards) だけで判定する。
//
// このテストで検証する契約:
// 1. アクセストークンが取れない場合はfetchすら呼ばず reauth_required/no_access_token を返す
// 2. Twitch APIのHTTPステータスを capability/reason/definitive へ正しくマッピングする
//    - definitive:true  = 401/403/200相当。呼び出し元がDBの確定状態を上書きしてよい
//    - definitive:false = 429/5xx/unexpected/network error等。既存の確定状態を破壊してはならない
// 3. 200時のレスポンス本文（報酬件数・内容）は判定に一切影響しない
// 4. リクエストURL・クエリパラメータ・認証ヘッダーが仕様通りである
// 5. アクセストークン/Authorizationヘッダーの値がログへ絶対に出力されない
//    （ソースコードのコメントで明示されている契約）
// 6. getTwitchAccessToken自体が例外(refresh失敗)をthrowした場合も、未捕捉のまま
//    呼び出し元(API route)へ伝播させず、結果オブジェクトへ変換する(Issue #1064)
//    - refreshが非retryable(invalid_grant等)で恒久的に失敗 → reauth_required/definitive:true
//    - refreshがretryable(429/5xx/network)で一時的に失敗 → unknown/definitive:false

const mocks = vi.hoisted(() => ({
  getTwitchAccessToken: vi.fn(),
}))

// TwitchTokenErrorは実クラスをそのまま使う。channel-points.tsが
// `error instanceof TwitchTokenError` で判定するため、モック側でも
// 同じクラス（コンストラクタ引数の並び含む）を再現する必要がある。
vi.mock('@/lib/twitch/token-manager', async () => {
  const actual = await vi.importActual<typeof import('@/lib/twitch/token-manager')>(
    '@/lib/twitch/token-manager'
  )
  return {
    ...actual,
    getTwitchAccessToken: mocks.getTwitchAccessToken,
  }
})

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/env-validation', () => ({
  getEnvVar: vi.fn().mockReturnValue('test-client-id'),
}))

const BROADCASTER_ID = 'broadcaster-1'
// トークン漏洩検知テストで「本当にこの文字列がログに出ていないか」を検証するための
// 十分ユニークな値（'token' のような一般語だと誤検知しやすいため）。
const FAKE_ACCESS_TOKEN = 'super-secret-broadcaster-access-token-xyz'
const EXPECTED_URL =
  `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${BROADCASTER_ID}&only_manageable_rewards=true`

/** 全てのモック呼び出し引数を文字列化し、指定した秘匿値が一切含まれないことを検証する */
function expectNoLeak(mockFn: ReturnType<typeof vi.fn>, secret: string) {
  for (const call of mockFn.mock.calls) {
    const serialized = JSON.stringify(call)
    expect(serialized.includes(secret)).toBe(false)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn())
  mocks.getTwitchAccessToken.mockResolvedValue(FAKE_ACCESS_TOKEN)
})

describe('probeChannelPointsCapability', () => {
  it('アクセストークンが取得できない場合、fetchを呼ばずreauth_required/no_access_tokenを返す', async () => {
    mocks.getTwitchAccessToken.mockResolvedValue(null)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'reauth_required',
      reason: 'no_access_token',
      definitive: true,
    })
    expect(result.httpStatus).toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('getTwitchAccessTokenが非retryableなrefresh失敗(TwitchTokenError)をthrowした場合、fetchを呼ばずreauth_required/token_refresh_failedを返す（definitive:true）', async () => {
    const { TwitchTokenError } = await import('@/lib/twitch/token-manager')
    mocks.getTwitchAccessToken.mockRejectedValue(
      new TwitchTokenError('Failed to refresh Twitch access token', 'REFRESH_FAILED', undefined, 400, 'http', false)
    )

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'reauth_required',
      reason: 'token_refresh_failed',
      definitive: true,
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('getTwitchAccessTokenがretryableなrefresh失敗(TwitchTokenError)をthrowした場合、fetchを呼ばずunknown/token_refresh_unavailableを返す（definitive:false。既存確定状態を破壊してはならない）', async () => {
    const { TwitchTokenError } = await import('@/lib/twitch/token-manager')
    mocks.getTwitchAccessToken.mockRejectedValue(
      new TwitchTokenError('Failed to refresh Twitch access token', 'REFRESH_FAILED', undefined, 503, 'http', true)
    )

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'unknown',
      reason: 'token_refresh_unavailable',
      definitive: false,
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('getTwitchAccessTokenがDATABASE_ERROR等(refreshRetryable未定義)のTwitchTokenErrorをthrowした場合も一時障害として扱う（definitive:false）', async () => {
    const { TwitchTokenError } = await import('@/lib/twitch/token-manager')
    mocks.getTwitchAccessToken.mockRejectedValue(
      new TwitchTokenError('Failed to fetch user tokens from database', 'DATABASE_ERROR')
    )

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'unknown',
      reason: 'token_refresh_unavailable',
      definitive: false,
    })
  })

  it('getTwitchAccessToken失敗時、logger.warnはエラー分類のみを記録しアクセストークンの値をログへ出力しない', async () => {
    const { TwitchTokenError } = await import('@/lib/twitch/token-manager')
    mocks.getTwitchAccessToken.mockRejectedValue(
      new TwitchTokenError('Failed to refresh Twitch access token', 'REFRESH_FAILED', undefined, 400, 'http', false)
    )

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    await probeChannelPointsCapability(BROADCASTER_ID)

    const { logger } = await import('@/lib/logger')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
    expectNoLeak(vi.mocked(logger.warn), FAKE_ACCESS_TOKEN)
    expectNoLeak(vi.mocked(logger.warn), `Bearer ${FAKE_ACCESS_TOKEN}`)
  })

  it('getTwitchAccessTokenをbroadcasterTwitchUserId単一引数で呼び出す', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 200 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    await probeChannelPointsCapability(BROADCASTER_ID)

    expect(mocks.getTwitchAccessToken).toHaveBeenCalledTimes(1)
    expect(mocks.getTwitchAccessToken).toHaveBeenCalledWith(BROADCASTER_ID)
  })

  it('200・空のdata配列でavailable/okを返す（報酬0件でも利用可能と判定する）', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'available',
      reason: 'ok',
      httpStatus: 200,
      definitive: true,
    })
  })

  it('200・非空の報酬配列でも同じくavailable/okを返す（報酬件数・内容は判定に影響しない）', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [
          { id: 'reward-1', title: 'Gacha', cost: 100, is_enabled: true },
          { id: 'reward-2', title: 'Another Reward', cost: 500, is_enabled: false },
        ],
      }),
    } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'available',
      reason: 'ok',
      httpStatus: 200,
      definitive: true,
    })
  })

  it('401でreauth_required/unauthorizedを返す（definitive:true）', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 401 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'reauth_required',
      reason: 'unauthorized',
      httpStatus: 401,
      definitive: true,
    })
  })

  it('403でunavailable/forbiddenを返す（definitive:true。非Affiliateで機能なし確定）', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 403 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'unavailable',
      reason: 'forbidden',
      httpStatus: 403,
      definitive: true,
    })
  })

  it('429でunknown/rate_limitedを返す（definitive:false。既存確定状態を破壊してはならない）', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 429 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'unknown',
      reason: 'rate_limited',
      httpStatus: 429,
      definitive: false,
    })
  })

  it('500でunknown/twitch_server_errorを返す（definitive:false）', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 500 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'unknown',
      reason: 'twitch_server_error',
      httpStatus: 500,
      definitive: false,
    })
  })

  it('503（他の5xx）でもunknown/twitch_server_errorを返す（definitive:false）', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 503 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'unknown',
      reason: 'twitch_server_error',
      httpStatus: 503,
      definitive: false,
    })
  })

  it('401/403/429/5xx以外の非2xx(418)ではunknown/unexpected_statusを返す（definitive:false）', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 418 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'unknown',
      reason: 'unexpected_status',
      httpStatus: 418,
      definitive: false,
    })
  })

  it('fetch自体が例外をthrow/rejectした場合、unknown/network_errorを返す（httpStatusなし）', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('network down'))

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    const result = await probeChannelPointsCapability(BROADCASTER_ID)

    expect(result).toEqual({
      capability: 'unknown',
      reason: 'network_error',
      definitive: false,
    })
    expect(result.httpStatus).toBeUndefined()
  })

  it('リクエストURLがbroadcaster_idとonly_manageable_rewards=trueを含む正しいものである', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 200 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    await probeChannelPointsCapability(BROADCASTER_ID)

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url] = vi.mocked(global.fetch).mock.calls[0]
    expect(url).toBe(EXPECTED_URL)
    expect(String(url)).toContain(`broadcaster_id=${BROADCASTER_ID}`)
    expect(String(url)).toContain('only_manageable_rewards=true')
  })

  it('Authorization/Client-Idヘッダーが正しく設定され、タイムアウト用のAbortSignalが渡される', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 200 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    await probeChannelPointsCapability(BROADCASTER_ID)

    const [, init] = vi.mocked(global.fetch).mock.calls[0]
    expect(init).toMatchObject({
      headers: {
        'Authorization': `Bearer ${FAKE_ACCESS_TOKEN}`,
        'Client-Id': 'test-client-id',
      },
    })
    // GETのみ・報酬の作成/更新/削除を行わない非破壊リクエストであることの確認
    // (methodを明示していない = デフォルトのGETである)
    expect((init as RequestInit).method).toBeUndefined()
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it('ネットワークエラー時、logger.warnはエラー分類のみを記録しアクセストークンの値をログへ出力しない', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('network down'))

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    await probeChannelPointsCapability(BROADCASTER_ID)

    const { logger } = await import('@/lib/logger')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
    expectNoLeak(vi.mocked(logger.warn), FAKE_ACCESS_TOKEN)
    expectNoLeak(vi.mocked(logger.warn), `Bearer ${FAKE_ACCESS_TOKEN}`)
  })

  it('想定外ステータス(418)時、logger.warnはstatusのみを記録しアクセストークンの値をログへ出力しない', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ status: 418 } as unknown as Response)

    const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
    await probeChannelPointsCapability(BROADCASTER_ID)

    const { logger } = await import('@/lib/logger')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.error).not.toHaveBeenCalled()
    expectNoLeak(vi.mocked(logger.warn), FAKE_ACCESS_TOKEN)
    expectNoLeak(vi.mocked(logger.warn), `Bearer ${FAKE_ACCESS_TOKEN}`)
  })

  it('definitive:trueとなる200/401/403、およびdefinitive:falseの429/5xxでは一切ログを出力しない', async () => {
    const { logger } = await import('@/lib/logger')

    for (const status of [200, 401, 403, 429, 500, 503]) {
      vi.clearAllMocks()
      mocks.getTwitchAccessToken.mockResolvedValue(FAKE_ACCESS_TOKEN)
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status } as unknown as Response))

      const { probeChannelPointsCapability } = await import('@/lib/twitch/channel-points')
      await probeChannelPointsCapability(BROADCASTER_ID)

      expect(logger.warn).not.toHaveBeenCalled()
      expect(logger.error).not.toHaveBeenCalled()
    }
  })
})
