import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { setSecurityHeaders, buildCsp } from '@/lib/security-headers'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('setSecurityHeaders', () => {
  it('X-Content-Type-Optionsヘッダーを設定する', () => {
    const response = NextResponse.json({ test: 'data' })
    const result = setSecurityHeaders(response)
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('X-Frame-Optionsヘッダーを設定する（デフォルトはDENY）', () => {
    const response = NextResponse.json({ test: 'data' })
    const result = setSecurityHeaders(response)
    expect(result.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('overlayルートではX-Frame-OptionsがSAMEORIGINになる', () => {
    // overlay ルートは同一オリジンからの iframe 埋め込みを許可（プレビュー機能用）
    const response = NextResponse.json({ test: 'data' })
    const result = setSecurityHeaders(response, { pathname: '/overlay/123' })
    expect(result.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  it('overlay以外のルートではX-Frame-OptionsがDENYのまま', () => {
    const response = NextResponse.json({ test: 'data' })
    const result = setSecurityHeaders(response, { pathname: '/dashboard/settings' })
    expect(result.headers.get('X-Frame-Options')).toBe('DENY')
  })

  describe('Content-Security-Policy', () => {
    it('開発環境ではlocalhostへの接続を許可する', () => {
      vi.stubEnv('NODE_ENV', 'development')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response)
      const csp = result.headers.get('Content-Security-Policy')
      expect(csp).toContain('localhost:*')
      // Development CSP includes 'unsafe-eval' for Next.js fast refresh and dev tools
      // 開発環境では Next.js の fast refresh と開発ツールのため 'unsafe-eval' が必要
      expect(csp).toContain('unsafe-eval')
      expect(csp).toContain('unsafe-inline')
    })

    it('本番環境ではlocalhostへの接続を許可しない', () => {
      vi.stubEnv('NODE_ENV', 'production')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response)
      const csp = result.headers.get('Content-Security-Policy')
      expect(csp).toContain('connect-src \'self\' https: wss:;')
      expect(csp).not.toContain('localhost')
      expect(csp).not.toContain('unsafe-eval')
      // production の script-src に unsafe-inline は含まれない（nonce ベース）。
      // style-src の unsafe-inline は Next.js のインラインスタイル用に維持。
      const scriptSrc = csp?.split(';').find((d) => d.trim().startsWith('script-src'))
      expect(scriptSrc).not.toContain('unsafe-inline')
      expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    })

    it('生成済み CSP 文字列を渡すとそれを採用する（middleware との nonce 契約）', () => {
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response, { csp: "default-src 'self'; script-src 'self' 'nonce-abc123' 'strict-dynamic';" })
      expect(result.headers.get('Content-Security-Policy')).toBe(
        "default-src 'self'; script-src 'self' 'nonce-abc123' 'strict-dynamic';"
      )
    })

    it('csp が空文字列の場合は buildCsp() へフォールバックする（fail-closed）', () => {
      vi.stubEnv('NODE_ENV', 'production')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response, { csp: '' })
      const csp = result.headers.get('Content-Security-Policy')
      const scriptSrc = csp?.split(';').find((d) => d.trim().startsWith('script-src'))
      expect(scriptSrc).not.toContain('unsafe-inline')
      expect(csp).toContain("default-src 'self'")
    })

    it('production nonce 経路は nonce 埋め込み・strict-dynamic・unsafe-inline 不在・host-source 不記載を満たす', () => {
      vi.stubEnv('NODE_ENV', 'production')
      const csp = buildCsp('abc123')
      const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))
      expect(scriptSrc).toContain("'nonce-abc123'")
      expect(scriptSrc).toContain("'strict-dynamic'")
      expect(scriptSrc).not.toContain('unsafe-inline')
      // strict-dynamic 下では host-source は無効のため記述しない
      expect(scriptSrc).not.toContain('static.cloudflareinsights.com')
      // style-src の unsafe-inline は Next.js のインラインスタイル用に維持する
      expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    })

    it('csp 未指定時は buildCsp() の nonce なし production CSP を使う', () => {
      vi.stubEnv('NODE_ENV', 'production')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response)
      const csp = result.headers.get('Content-Security-Policy')
      const scriptSrc = csp?.split(';').find((d) => d.trim().startsWith('script-src'))
      expect(scriptSrc).not.toContain('unsafe-inline')
      expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    })

    it('buildCsp は nonce なし本番で unsafe-inline を含まない（早期 return 経路はスクリプトなし）', () => {
      vi.stubEnv('NODE_ENV', 'production')
      const csp = buildCsp()
      const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))
      expect(scriptSrc).not.toContain('unsafe-inline')
      // style-src の unsafe-inline は Next.js のインラインスタイル用に維持する
      expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    })

    it('開発環境でも nonce を script-src へ含める（dev で nonce 経路を再現）', () => {
      vi.stubEnv('NODE_ENV', 'development')
      const csp = buildCsp('devnonce123')
      expect(csp).toContain("'nonce-devnonce123'")
      // dev では fast refresh 用の unsafe-eval とインライン用 unsafe-inline を維持
      expect(csp).toContain('unsafe-eval')
    })

    const EXPECTED_DIRECTIVE_NAMES = [
      'default-src',
      'base-uri',
      'script-src',
      'style-src',
      'img-src',
      'media-src',
      'connect-src',
      'font-src',
      'worker-src',
      'object-src',
      'form-action',
      'frame-ancestors',
    ]

    // variant 非依存の directive は値込みで固定する。名前のみだと
    // `object-src 'self'` への緩和などを検出できない。
    const COMMON_DIRECTIVE_VALUES = [
      "default-src 'self'",
      "base-uri 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: blob:",
      "media-src 'self' https:",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ]

    it.each([
      ['production nonce なし', () => { vi.stubEnv('NODE_ENV', 'production'); return buildCsp() }],
      ['production nonce あり', () => { vi.stubEnv('NODE_ENV', 'production'); return buildCsp('nonce1') }],
      ['development nonce なし', () => { vi.stubEnv('NODE_ENV', 'development'); return buildCsp() }],
      ['development nonce あり', () => { vi.stubEnv('NODE_ENV', 'development'); return buildCsp('nonce1') }],
    ])('%s で全 directive が固定されている（乖離防止）', (_label, build) => {
      const csp = build()
      // directive 名を出現順の配列で完全一致比較する。Set 化すると同名 directive の
      // 二重出力（後勝ちで事故る典型）を検出できないため、配列のままで順序・重複・
      // 欠落を同時に固定する。
      const actualDirectives = csp
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => d.split(/\s+/)[0])
      expect(actualDirectives).toEqual(EXPECTED_DIRECTIVE_NAMES)
      // variant 非依存 directive は値込みで検証
      for (const directive of COMMON_DIRECTIVE_VALUES) {
        expect(csp).toContain(`${directive};`)
      }
    })
  })

  describe('Strict-Transport-Security', () => {
    it('本番環境でのみHSTSを設定する', () => {
      vi.stubEnv('NODE_ENV', 'production')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response)
      expect(result.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains; preload')
    })

    it('開発環境ではHSTSを設定しない', () => {
      vi.stubEnv('NODE_ENV', 'development')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response)
      expect(result.headers.get('Strict-Transport-Security')).toBeNull()
    })
  })
})
