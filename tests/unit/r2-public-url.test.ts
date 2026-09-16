import { afterEach, describe, expect, it, vi } from 'vitest'

import { getR2PublicUrl, getR2SoundPublicUrl } from '@/lib/r2-client'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('R2 public URL helpers', () => {
  it('R2_PUBLIC_URL の末尾スラッシュを除去して返す', () => {
    vi.stubEnv('R2_PUBLIC_URL', 'https://images.example.test/')

    expect(getR2PublicUrl()).toBe('https://images.example.test')
  })

  it('R2_PUBLIC_URL が未設定なら fail-closed で例外を投げる', () => {
    vi.stubEnv('R2_PUBLIC_URL', undefined)

    expect(() => getR2PublicUrl()).toThrow('Missing R2_PUBLIC_URL environment variable')
  })

  it('R2_SOUND_PUBLIC_URL の末尾スラッシュを除去して返す', () => {
    vi.stubEnv('R2_SOUND_PUBLIC_URL', 'https://sounds.example.test/')

    expect(getR2SoundPublicUrl()).toBe('https://sounds.example.test')
  })

  it('R2_SOUND_PUBLIC_URL が未設定なら fail-closed で例外を投げる', () => {
    vi.stubEnv('R2_SOUND_PUBLIC_URL', undefined)

    expect(() => getR2SoundPublicUrl()).toThrow('Missing R2_SOUND_PUBLIC_URL environment variable')
  })
})
