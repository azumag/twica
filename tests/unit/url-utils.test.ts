import { describe, it, expect, vi, afterEach } from 'vitest'
import { getBaseUrl, resolveAllowedOrigin } from '@/lib/url-utils'

/**
 * #836 項目6: getBaseUrl の host ヘッダー allowlist 検証。
 * ホストヘッダ注入で OAuth redirect_uri 等を混線させられないことを保証する。
 */
describe('resolveAllowedOrigin (issue #836)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('ローカル開発 origin を許可する', () => {
    expect(resolveAllowedOrigin('localhost:8787', null)).toBe('http://localhost:8787')
    expect(resolveAllowedOrigin('localhost:3000', null)).toBe('http://localhost:3000')
    expect(resolveAllowedOrigin('127.0.0.1:8787', null)).toBe('http://127.0.0.1:8787')
  })

  it('NEXT_PUBLIC_APP_URL のホストを許可する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('twica.bluemoon.works', 'https')).toBe('https://twica.bluemoon.works')
  })

  it('preview の workers.dev ドメインを許可する', () => {
    expect(resolveAllowedOrigin('twica-preview.tsubasa-azumagakito.workers.dev', 'https'))
      .toBe('https://twica-preview.tsubasa-azumagakito.workers.dev')
  })

  it('production の workers.dev ドメインを許可する（OAuth を workers.dev から開始するため）', () => {
    expect(resolveAllowedOrigin('twica.tsubasa-azumagakito.workers.dev', 'https'))
      .toBe('https://twica.tsubasa-azumagakito.workers.dev')
  })

  it('未知のホスト / 非許可 port はフォールバック origin を返す（fail-closed）', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('evil.example.com', 'https')).toBe('https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('twica.bluemoon.works.evil.com', 'https')).toBe('https://twica.bluemoon.works')
    // 許可ホストでも非許可 port は拒否（完全 origin 一致のため）
    expect(resolveAllowedOrigin('twica.bluemoon.works:4444', 'https')).toBe('https://twica.bluemoon.works')
    expect(resolveAllowedOrigin(null, null)).toBe('https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('', 'https')).toBe('https://twica.bluemoon.works')
  })
})

describe('getBaseUrl (issue #836)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function makeRequest(host: string | null, forwardedProto: string | null = null): Request {
    const headers = new Headers()
    if (host) headers.set('host', host)
    if (forwardedProto) headers.set('x-forwarded-proto', forwardedProto)
    // Node/undici の fetch は Request 構築時に Host ヘッダーを抑制する（forbidden
    // header）ため、getBaseUrl が host ヘッダーを読めるよう最小の Request 風オブジェクトを
    // 渡す（getBaseUrl が参照するのは headers のみ）。
    return { headers } as unknown as Request
  }

  it('許可ホストの host ヘッダーを使う', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('twica.bluemoon.works', 'https'))).toBe('https://twica.bluemoon.works')
  })

  it('preview ドメインは許可される', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('twica-preview.tsubasa-azumagakito.workers.dev', 'https')))
      .toBe('https://twica-preview.tsubasa-azumagakito.workers.dev')
  })

  it('非許可ホスト・非許可 port は NEXT_PUBLIC_APP_URL にフォールバックする', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('evil.example.com', 'https'))).toBe('https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('twica.bluemoon.works:4444', 'https'))).toBe('https://twica.bluemoon.works')
  })

  it('host ヘッダー欠落時はフォールバックする', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest(null))).toBe('https://twica.bluemoon.works')
  })

  it('ローカル開発は http で返す（x-forwarded-proto より優先）', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('localhost:8787', 'https'))).toBe('http://localhost:8787')
  })
})
