import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveChatNotificationDeliveryMode: vi.fn(),
  advanceChatNotificationDeliveryCursor: vi.fn(),
  sendChatAnnouncement: vi.fn(),
  sendPacedMultiDrawChatAnnouncement: vi.fn(),
}))

vi.mock('@/lib/services/chat-notification-congestion', () => ({
  resolveChatNotificationDeliveryMode: mocks.resolveChatNotificationDeliveryMode,
}))

vi.mock('@/lib/services/chat-notification-outbox', () => ({
  advanceChatNotificationDeliveryCursor: mocks.advanceChatNotificationDeliveryCursor,
}))

vi.mock('@/lib/services/eventsub-redemption', () => ({
  sendChatAnnouncement: mocks.sendChatAnnouncement,
}))

vi.mock('@/lib/twitch/paced-multi-draw-sender', () => ({
  sendPacedMultiDrawChatAnnouncement: mocks.sendPacedMultiDrawChatAnnouncement,
}))

function card(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    image_url: null,
    rarity: 'rare',
    drop_rate: 1,
  }
}

function makeData(withCardCounts: boolean) {
  const first = card('card-1', 'Alpha')
  const second = card('card-2', 'Beta')
  return {
    broadcasterTwitchUserId: 'broadcaster-1',
    userId: 'viewer-1',
    streamer: {
      id: 'streamer-1',
      chat_announcement_enabled: true,
      chat_announcement_template: '@{user} single {card} {num} {unique}',
      chat_announcement_multi_template: '@{user} multi {cards}',
      chat_announcement_multi_show_cards: true,
      default_card_pack_name: null,
    },
    gachaResult: {
      type: 'gacha' as const,
      userTwitchUsername: 'Viewer',
      card: first,
      cards: [first, second],
      collectionName: 'Collection',
    },
    chatSnapshot: {
      cardCount: 1,
      uniqueCount: 2,
      allCount: 10,
      newCardNames: ['Alpha', 'Beta'],
      newCardNamesResolved: true,
      ...(withCardCounts
        ? { cardCounts: { 'card-1': 1, 'card-2': 1 } }
        : {}),
    },
  }
}

function makeClaim() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    batchId: 'batch-1',
    leaseId: '22222222-2222-4222-8222-222222222222',
    attemptCount: 1,
    payloadVersion: 1,
    payload: {},
    expectedDrawCount: 2,
    assembledDrawCount: 2,
    deliveryMode: 'individual' as const,
    deliveryChunkSize: 3,
    deliveryCursor: 0,
    deliveryModeResolved: true,
    createdAt: '2026-09-15T00:00:00.000Z',
  }
}

describe('sendClaimedChatAnnouncement individual delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveChatNotificationDeliveryMode.mockResolvedValue('individual')
    mocks.advanceChatNotificationDeliveryCursor.mockResolvedValue(true)
    mocks.sendChatAnnouncement.mockResolvedValue({ outcome: 'sent' })
  })

  it('routes each new individual segment through the normal single-draw announcement function', async () => {
    const data = makeData(true)
    mocks.sendPacedMultiDrawChatAnnouncement.mockImplementation(
      async (_broadcaster, cards, _userName, options) => {
        expect(options.sendIndividualCard).toBeTypeOf('function')
        await options.sendIndividualCard?.(cards[1], 1)
        return { outcome: 'sent' }
      },
    )

    const { sendClaimedChatAnnouncement } = await import('@/lib/services/eventsub-redemption-delivery')
    const fence = vi.fn().mockResolvedValue(true)
    await expect(sendClaimedChatAnnouncement(
      makeClaim() as never,
      data as never,
      fence,
    )).resolves.toEqual({ outcome: 'sent' })

    expect(mocks.sendChatAnnouncement).toHaveBeenCalledExactlyOnceWith(
      'broadcaster-1',
      data.streamer,
      data.gachaResult.cards[1],
      'Viewer',
      'viewer-1',
      undefined,
      'Collection',
      expect.objectContaining({
        cardCount: 1,
        uniqueCount: 2,
        allCount: 10,
      }),
      fence,
    )
  })

  it('keeps pre-cardCounts outboxes on the legacy deterministic paced fallback', async () => {
    const data = makeData(false)
    mocks.sendPacedMultiDrawChatAnnouncement.mockImplementation(
      async (_broadcaster, _cards, _userName, options) => {
        expect(options.sendIndividualCard).toBeUndefined()
        return { outcome: 'sent' }
      },
    )

    const { sendClaimedChatAnnouncement } = await import('@/lib/services/eventsub-redemption-delivery')
    await expect(sendClaimedChatAnnouncement(
      makeClaim() as never,
      data as never,
      vi.fn().mockResolvedValue(true),
    )).resolves.toEqual({ outcome: 'sent' })

    expect(mocks.sendChatAnnouncement).not.toHaveBeenCalled()
  })
})
