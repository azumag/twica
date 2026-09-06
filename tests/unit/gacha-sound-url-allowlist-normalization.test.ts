import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAllowedSoundUrl } from '@/lib/gacha-sound-rules'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('gacha sound URL allowlist normalization (#1375)', () => {
  it('明示allowlistはtrim・大小文字無視のhostname完全一致で判定し、URL側のportは比較しない', () => {
    vi.stubEnv('R2_SOUND_PUBLIC_URL', '')
    vi.stubEnv('R2_PUBLIC_URL', '')
    vi.stubEnv('ALLOWED_SOUND_HOSTS', '  CDN.Example.COM , media.example.com  ')

    expect(isAllowedSoundUrl('https://cdn.example.com:8443/sound.mp3')).toBe(true)
    expect(isAllowedSoundUrl('https://media.example.com/sound.mp3')).toBe(true)
    expect(isAllowedSoundUrl('https://cdn.example.com.evil.test/sound.mp3')).toBe(false)
  })

  it('R2由来allowlistもURLのhostnameだけを正規化して使う', () => {
    vi.stubEnv('ALLOWED_SOUND_HOSTS', '')
    vi.stubEnv('R2_SOUND_PUBLIC_URL', 'https://SOUNDS.Example.COM:9443/assets')
    vi.stubEnv('R2_PUBLIC_URL', 'https://images.example.com/base')

    expect(isAllowedSoundUrl('https://sounds.example.com/sound.mp3')).toBe(true)
    expect(isAllowedSoundUrl('https://images.example.com:8443/sound.mp3')).toBe(true)
    expect(isAllowedSoundUrl('https://other.example.com/sound.mp3')).toBe(false)
  })
})
