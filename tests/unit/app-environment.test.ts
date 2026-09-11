import { describe, expect, it } from 'vitest'
import { resolveAppEnvironment } from '@/lib/app-environment'

describe('resolveAppEnvironment', () => {
  it('NEXT_PUBLIC_APP_URL が未設定なら production を返す', () => {
    expect(resolveAppEnvironment(undefined)).toBe('production')
  })

  it('production URL なら production を返す', () => {
    expect(resolveAppEnvironment('https://twica.example.com')).toBe('production')
  })

  it('preview を含む URL なら preview を返す', () => {
    expect(resolveAppEnvironment('https://twica-preview.example.workers.dev')).toBe('preview')
  })
})
