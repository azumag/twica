import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '@/lib/db/client'
import { logErrorFromLogger, reportError } from '@/lib/sentry/error-handler'

vi.mock('@/lib/db/client', () => ({
  getDb: vi.fn(),
}))

const mockValues = vi.fn().mockResolvedValue(undefined)
const mockInsert = vi.fn().mockReturnValue({ values: mockValues })

function drizzleStyleError(): Error & { params: string[] } {
  const error = Object.assign(
    new Error('Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value'),
    { params: ['sensitive-token-value'] },
  )
  error.name = 'DrizzleQueryError'
  error.stack = 'DrizzleQueryError: Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value\n    at query.ts:1:1'
  return error
}

describe('sentry error persistence redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(getDb).mockResolvedValue({
      db: { insert: mockInsert } as never,
      sql: {} as never,
    })
  })

  it('reportErrorはDrizzle message / stackのbind paramsをDBへ保存しない', async () => {
    await reportError(drizzleStyleError())

    const values = mockValues.mock.calls[0][0]
    expect(values.message).toContain('params: [REDACTED]')
    expect(values.message).not.toContain('sensitive-token-value')
    expect(values.stack_trace).toContain('params: [REDACTED]')
    expect(values.stack_trace).toContain('at query.ts:1:1')
    expect(values.stack_trace).not.toContain('sensitive-token-value')
  })

  it('logErrorFromLoggerへraw Errorを直接渡してもbind paramsをDBへ保存しない', async () => {
    await logErrorFromLogger('token save failed', [drizzleStyleError()])

    const values = mockValues.mock.calls[0][0]
    expect(values.message).toContain('token save failed Failed query:')
    expect(values.message).toContain('params: [REDACTED]')
    expect(values.message).not.toContain('sensitive-token-value')
    expect(values.stack_trace).toContain('params: [REDACTED]')
    expect(values.stack_trace).not.toContain('sensitive-token-value')
  })
})
