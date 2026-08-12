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
    vi.stubEnv('NODE_ENV', 'development')
    expect(resolveAllowedOrigin('localhost:8787')).toBe('http://localhost:8787')
    expect(resolveAllowedOrigin('localhost:3000')).toBe('http://localhost:3000')
    expect(resolveAllowedOrigin('127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    vi.unstubAllEnvs()
  })

  it('production では localhost origin を拒否する（Host ヘッダ注入の抜け穴を塞ぐ）', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('localhost:3000')).toBe('https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('127.0.0.1:8787')).toBe('https://twica.bluemoon.works')
    vi.unstubAllEnvs()
  })

  it('NEXT_PUBLIC_APP_URL のホストを許可する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('twica.bluemoon.works')).toBe('https://twica.bluemoon.works')
  })

  it('preview の workers.dev ドメインを許可する', () => {
    expect(resolveAllowedOrigin('twica-preview.tsubasa-azumagakito.workers.dev'))
      .toBe('https://twica-preview.tsubasa-azumagakito.workers.dev')
  })

  it('production の workers.dev ドメインを許可する（OAuth を workers.dev から開始するため）', () => {
    expect(resolveAllowedOrigin('twica.tsubasa-azumagakito.workers.dev'))
      .toBe('https://twica.tsubasa-azumagakito.workers.dev')
  })

  it('カスタムドメイン（NEXT_PUBLIC_APP_URL）は warn を出さずに許可する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resolveAllowedOrigin('twica.bluemoon.works')).toBe('https://twica.bluemoon.works')
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('version preview URL（<version>-twica-preview 等）を許可する', () => {
    // Workers Builds が生成するブランチ/コミット単位の preview Worker
    expect(resolveAllowedOrigin('38878a9f-twica-preview.tsubasa-azumagakito.workers.dev'))
      .toBe('https://38878a9f-twica-preview.tsubasa-azumagakito.workers.dev')
    expect(resolveAllowedOrigin('codex-issue-836-csp-host-twica-preview.tsubasa-azumagakito.workers.dev'))
      .toBe('https://codex-issue-836-csp-host-twica-preview.tsubasa-azumagakito.workers.dev')
  })

  it('production で NEXT_PUBLIC_APP_URL 未設定でも workers.dev は許可する（二重防御）', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(resolveAllowedOrigin('twica-preview.tsubasa-azumagakito.workers.dev'))
      .toBe('https://twica-preview.tsubasa-azumagakito.workers.dev')
    expect(resolveAllowedOrigin('twica.tsubasa-azumagakito.workers.dev'))
      .toBe('https://twica.tsubasa-azumagakito.workers.dev')
  })

  it('未知のホスト / 非許可 port はフォールバック origin を返す（fail-closed）', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('evil.example.com')).toBe('https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('twica.bluemoon.works.evil.com')).toBe('https://twica.bluemoon.works')
    // 許可ホストでも非許可 port は拒否（完全 origin 一致のため）
    expect(resolveAllowedOrigin('twica.bluemoon.works:4444')).toBe('https://twica.bluemoon.works')
    expect(resolveAllowedOrigin(null)).toBe('https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('')).toBe('https://twica.bluemoon.works')
  })

  it('workers.dev サブドメインの文字種が不正な host は拒否する（500 化を防ぐ）', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    // 空白・記号入りはアカウント専有ドメインに該当しないため fail-closed
    expect(resolveAllowedOrigin('twica preview.tsubasa-azumagakito.workers.dev'))
      .toBe('https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('twica.preview@evil.tsubasa-azumagakito.workers.dev'))
      .toBe('https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('TWICA-preview.tsubasa-azumagakito.workers.dev'))
      .toBe('https://twica-preview.tsubasa-azumagakito.workers.dev')
  })

  it('非許可ホストは warn を1回だけ出力してフォールバックする', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resolveAllowedOrigin('evil.example.com')).toBe('https://twica.bluemoon.works')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('production で NEXT_PUBLIC_APP_URL 未設定なら throw する（localhost へ倒さない）', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(() => resolveAllowedOrigin('evil.example.com')).toThrow('NEXT_PUBLIC_APP_URL is required in production')
    vi.unstubAllEnvs()
  })

  it('production で NEXT_PUBLIC_APP_URL が不正なら throw する', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'not-a-url')
    expect(() => resolveAllowedOrigin('evil.example.com')).toThrow('invalid in production')
    vi.unstubAllEnvs()
  })
})

describe('getBaseUrl (issue #836)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function makeRequest(host: string | null): Request {
    const headers = new Headers()
    if (host) headers.set('host', host)
    // Node/undici の fetch は Request 構築時に Host ヘッダーを抑制する（forbidden
    // header）ため、getBaseUrl が host ヘッダーを読めるよう最小の Request 風オブジェクトを
    // 渡す（getBaseUrl が参照するのは headers のみ）。
    return { headers } as unknown as Request
  }

  it('許可ホストの host ヘッダーを使う', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('twica.bluemoon.works'))).toBe('https://twica.bluemoon.works')
  })

  it('preview ドメインは許可される', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('twica-preview.tsubasa-azumagakito.workers.dev')))
      .toBe('https://twica-preview.tsubasa-azumagakito.workers.dev')
  })

  it('非許可ホスト・非許可 port は NEXT_PUBLIC_APP_URL にフォールバックする', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('evil.example.com'))).toBe('https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('twica.bluemoon.works:4444'))).toBe('https://twica.bluemoon.works')
  })

  it('host ヘッダー欠落時はフォールバックする', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest(null))).toBe('https://twica.bluemoon.works')
  })

  it('ローカル開発は http で返す', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(getBaseUrl(makeRequest('localhost:8787'))).toBe('http://localhost:8787')
    vi.unstubAllEnvs()
  })
})
