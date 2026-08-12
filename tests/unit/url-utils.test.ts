import { describe, it, expect, vi, afterEach } from 'vitest'
import { getBaseUrl, isTrustedOrigin, resolveAllowedOrigin } from '@/lib/url-utils'

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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 空白・記号入りはアカウント専有ドメインに該当しないため fail-closed
      expect(resolveAllowedOrigin('twica preview.tsubasa-azumagakito.workers.dev'))
        .toBe('https://twica.bluemoon.works')
      expect(resolveAllowedOrigin('twica.preview@evil.tsubasa-azumagakito.workers.dev'))
        .toBe('https://twica.bluemoon.works')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('大文字の workers.dev ホストは小文字化して許可する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(resolveAllowedOrigin('TWICA-preview.tsubasa-azumagakito.workers.dev'))
      .toBe('https://twica-preview.tsubasa-azumagakito.workers.dev')
  })

  it('twica が先頭 label にない workers.dev サブドメインは拒否する（締め付け）', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // worker 名（先頭 label）に twica を含まないサブドメインは拒否する
      expect(resolveAllowedOrigin('evil.twica.tsubasa-azumagakito.workers.dev'))
        .toBe('https://twica.bluemoon.works')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('workers.dev ホストの非許可 port は拒否する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(resolveAllowedOrigin('twica.tsubasa-azumagakito.workers.dev:8443'))
        .toBe('https://twica.bluemoon.works')
    } finally {
      warnSpy.mockRestore()
    }
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

describe('isTrustedOrigin (issue #950)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('カスタムドメインの origin を許可する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(isTrustedOrigin('https://twica.bluemoon.works')).toBe(true)
  })

  it('workers.dev（twica 系）の origin を許可する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(isTrustedOrigin('https://twica.tsubasa-azumagakito.workers.dev')).toBe(true)
    expect(isTrustedOrigin('https://twica-preview.tsubasa-azumagakito.workers.dev')).toBe(true)
    expect(isTrustedOrigin('https://codex-issue-836-twica-preview.tsubasa-azumagakito.workers.dev')).toBe(true)
  })

  it('非許可 origin を拒否する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(isTrustedOrigin('https://evil.example.com')).toBe(false)
    expect(isTrustedOrigin('https://twica.bluemoon.works.evil.com')).toBe(false)
    expect(isTrustedOrigin('https://twica.tsubasa-azumagakito.workers.dev.evil.com')).toBe(false)
    expect(isTrustedOrigin('not-a-url')).toBe(false)
  })

  it('path や userinfo 付きの URL は origin 文字列ではないため拒否する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(isTrustedOrigin('https://twica.bluemoon.works/evil')).toBe(false)
    expect(isTrustedOrigin('https://user@twica.bluemoon.works')).toBe(false)
    expect(isTrustedOrigin('https://twica-preview.tsubasa-azumagakito.workers.dev/evil')).toBe(false)
    expect(isTrustedOrigin('')).toBe(false)
    expect(isTrustedOrigin('http://localhost:3000/')).toBe(false)
  })

  it('workers.dev は https のみ許可する（http は拒否）', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(isTrustedOrigin('http://twica.tsubasa-azumagakito.workers.dev')).toBe(false)
  })

  it('production では localhost origin を拒否する', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(isTrustedOrigin('http://localhost:3000')).toBe(false)
    expect(isTrustedOrigin('http://localhost:8787')).toBe(false)
  })

  it('port 付き workers.dev origin を拒否する', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://twica.bluemoon.works')
    expect(isTrustedOrigin('https://twica.tsubasa-azumagakito.workers.dev:8443')).toBe(false)
  })

  it('開発環境では localhost origin を許可する', () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect(isTrustedOrigin('http://localhost:3000')).toBe(true)
    expect(isTrustedOrigin('http://localhost:8787')).toBe(true)
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
