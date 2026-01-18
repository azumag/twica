import { describe, it, expect, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { setSecurityHeaders } from '@/lib/security-headers'

describe('setSecurityHeaders', () => {
  it('X-Content-Type-Optionsヘッダーを設定する', () => {
    const response = NextResponse.json({ test: 'data' })
    const result = setSecurityHeaders(response)
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('X-Frame-Optionsヘッダーを設定する', () => {
    const response = NextResponse.json({ test: 'data' })
    const result = setSecurityHeaders(response)
    expect(result.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('X-XSS-Protectionヘッダーを設定する', () => {
    const response = NextResponse.json({ test: 'data' })
    const result = setSecurityHeaders(response)
    expect(result.headers.get('X-XSS-Protection')).toBe('1; mode=block')
  })

  describe('Content-Security-Policy', () => {
    it('開発環境ではlocalhostへの接続を許可する', () => {
      vi.stubEnv('NODE_ENV', 'development')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response)
      const csp = result.headers.get('Content-Security-Policy')
      expect(csp).toContain('localhost:*')
      expect(csp).toContain('unsafe-eval')
      expect(csp).toContain('unsafe-inline')
      vi.unstubAllEnvs()
    })

    it('本番環境ではlocalhostへの接続を許可しない', () => {
      vi.stubEnv('NODE_ENV', 'production')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response)
      const csp = result.headers.get('Content-Security-Policy')
      expect(csp).toContain('connect-src \'self\' https:;')
      expect(csp).not.toContain('localhost')
      expect(csp).not.toContain('unsafe-eval')
      expect(csp).not.toContain('unsafe-inline')
      vi.unstubAllEnvs()
    })
  })

  describe('Strict-Transport-Security', () => {
    it('本番環境でのみHSTSを設定する', () => {
      vi.stubEnv('NODE_ENV', 'production')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response)
      expect(result.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains; preload')
      vi.unstubAllEnvs()
    })

    it('開発環境ではHSTSを設定しない', () => {
      vi.stubEnv('NODE_ENV', 'development')
      const response = NextResponse.json({ test: 'data' })
      const result = setSecurityHeaders(response)
      expect(result.headers.get('Strict-Transport-Security')).toBeNull()
      vi.unstubAllEnvs()
    })
  })
})
