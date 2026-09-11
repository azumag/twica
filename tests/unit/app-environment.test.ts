import { afterEach, describe, expect, it } from 'vitest'
import { resolveAppEnvironment } from '@/lib/app-environment'

describe('resolveAppEnvironment', () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  it('NEXT_PUBLIC_APP_URL が未設定なら production を返す', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(resolveAppEnvironment()).toBe('production')
  })

  it('production URL なら production を返す', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica.example.com'
    expect(resolveAppEnvironment()).toBe('production')
  })

  it('preview を含む URL なら preview を返す', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://twica-preview.example.workers.dev'
    expect(resolveAppEnvironment()).toBe('preview')
  })
})
