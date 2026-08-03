import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger.server'
import {
  getChatDeliveryCapability,
  resolveChatDeliveryCapability,
} from '@/lib/twitch/chat-delivery-capability'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveChatDeliveryCapability', () => {
  it('通知が無効なら送信手段がなくてもattentionにしない', () => {
    expect(resolveChatDeliveryCapability({
      chatAnnouncementEnabled: false,
      hasStoredScope: false,
      hasActiveBot: false,
    })).toMatchObject({ canSendChat: false, needsAttention: false })
  })

  it('本人の保存scopeがあれば送信可能', () => {
    expect(resolveChatDeliveryCapability({
      chatAnnouncementEnabled: true,
      hasStoredScope: true,
      hasActiveBot: false,
    })).toMatchObject({ canSendChat: true, needsAttention: false })
  })

  it('本人scopeがなくてもactive Botがあれば送信可能', () => {
    expect(resolveChatDeliveryCapability({
      chatAnnouncementEnabled: true,
      hasStoredScope: false,
      hasActiveBot: true,
    })).toMatchObject({ canSendChat: true, needsAttention: false })
  })

  it('通知有効かつ本人scopeもactive Botもなければattention', () => {
    expect(resolveChatDeliveryCapability({
      chatAnnouncementEnabled: true,
      hasStoredScope: false,
      hasActiveBot: false,
    })).toMatchObject({ canSendChat: false, needsAttention: true })
  })

  it('設定query失敗時は送信不能と断定せずattentionにしない', async () => {
    // 取得失敗は capability が「不明」の状態であり、正常に不足を確認した結果とは
    // 区別する。ここで false-positive を防ぐと、同じhelperを使うdashboard bannerと
    // settings sidebarの両方が一貫して非警告になる。
    vi.mocked(getDb).mockRejectedValueOnce(new Error('database unavailable'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

    await expect(getChatDeliveryCapability('query-failure-user')).resolves.toMatchObject({
      canSendChat: false,
      needsAttention: false,
    })
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to resolve chat delivery capability for dashboard',
      expect.objectContaining({
        broadcasterTwitchUserId: 'query-failure-user',
        error: 'database unavailable',
      }),
    )
  })
})
