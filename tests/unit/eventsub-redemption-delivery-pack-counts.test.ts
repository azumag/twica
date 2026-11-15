import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TwitchChatService } from '@/lib/twitch/chat-service'
import type { GachaCard } from '@/lib/services/gacha'

// Issue #2047: PR #2046 レビューの任意指摘の退避先。individual 配送で draw ごとの
// {packUnique} が実際の通知本文に出ることを、sendClaimedChatAnnouncement から
// buildMessage までの実装を通して検証する結合テスト。
//
// 既存の eventsub-redemption-delivery.test.ts は sendChatAnnouncement /
// sendPacedMultiDrawChatAnnouncement を丸ごとモックしており、snapshot → 本文の
// 変換は send-chat-announcement.test.ts（sendChatAnnouncement 直接呼び出し）と
// multi-draw-chat.test.ts（buildIndividualChatSnapshot 単体）でしか検証されていない。
// ここでは paced sender・snapshot 復元・テンプレート解決をすべて実装のまま動かし、
// 外部送信（sendChatMessageDetailed）と DB 境界（delivery mode 解決・cursor 永続化）
// だけを差し替える。

const mocks = vi.hoisted(() => ({
  resolveChatNotificationDeliveryMode: vi.fn(),
  advanceChatNotificationDeliveryCursor: vi.fn(),
}))

// eventsub-redemption.ts もこの module から他の関数を import しているため、
// 実装を維持したまま cursor 永続化だけを差し替える（他exportを消すとimportが壊れる）。
vi.mock('@/lib/services/chat-notification-outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/chat-notification-outbox')>()),
  advanceChatNotificationDeliveryCursor: mocks.advanceChatNotificationDeliveryCursor,
}))
vi.mock('@/lib/services/chat-notification-congestion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/chat-notification-congestion')>()),
  resolveChatNotificationDeliveryMode: mocks.resolveChatNotificationDeliveryMode,
}))

function card(id: string, name: string, collectionName: string | null): GachaCard {
  return {
    id,
    name,
    description: null,
    image_url: null,
    rarity: 'rare',
    drop_rate: 1,
    collection_name: collectionName,
  }
}

// 3連とも 'Alpha' パック。a1 は既所持（cardCounts 5 > drawn 1）、a2/a3 は今回の
// バッチで初入手（final = drawn = 1）。final の packUnique=3 から draw ごとに
// 1 → 2 → 3 と復元されることを期待する。
const a1 = card('card-a1', 'Alpha-1', 'Alpha')
const a2 = card('card-a2', 'Alpha-2', 'Alpha')
const a3 = card('card-a3', 'Alpha-3', 'Alpha')

const data = {
  broadcasterTwitchUserId: 'broadcaster-1',
  userId: 'viewer-1',
  streamer: {
    id: 'streamer-1',
    chat_announcement_enabled: true,
    chat_announcement_template: '@{user} {card} pack={packUnique}/{packAll}',
    chat_announcement_multi_template: null,
    chat_announcement_multi_show_cards: true,
    default_card_pack_name: null,
  },
  gachaResult: {
    type: 'gacha' as const,
    userTwitchUsername: 'Viewer',
    card: a1,
    cards: [a1, a2, a3],
    collectionName: null,
  },
  chatSnapshot: {
    cardCount: 5,
    uniqueCount: 3,
    allCount: 10,
    newCardNames: ['Alpha-2', 'Alpha-3'],
    newCardNamesResolved: true,
    cardCounts: { 'card-a1': 5, 'card-a2': 1, 'card-a3': 1 },
    packCounts: { Alpha: { unique: 3, all: 4 } },
  },
}

const claim = {
  id: '11111111-1111-4111-8111-111111111111',
  batchId: 'batch-1',
  leaseId: '22222222-2222-4222-8222-222222222222',
  attemptCount: 1,
  payloadVersion: 2,
  payload: {},
  deliveryMode: 'individual' as const,
  deliveryChunkSize: 3,
  deliveryCursor: 0,
  createdAt: '2026-11-15T00:00:00.000Z',
}

describe('sendClaimedChatAnnouncement individual delivery renders per-draw {packUnique} (#2047)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveChatNotificationDeliveryMode.mockResolvedValue('individual')
    mocks.advanceChatNotificationDeliveryCursor.mockResolvedValue(true)
  })

  it('sends one message per draw with the reconstructed pack progress of that draw', async () => {
    const sendSpy = vi
      .spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed')
      .mockResolvedValue({ outcome: 'sent' })
    const { sendClaimedChatAnnouncement } = await import(
      '@/lib/services/eventsub-redemption-delivery'
    )

    // channelGate を渡すと sender はプロセス内 delay() を使わず予約だけで間隔を
    // 管理する（chat-notification-delivery の本番経路と同じ）。テストが
    // MULTI_DRAW_CHAT_INTERVAL_MS 分待たずに済む。
    const outcome = await sendClaimedChatAnnouncement(
      claim as never,
      data as never,
      vi.fn().mockResolvedValue(true),
      { channelGate: vi.fn().mockResolvedValue({ outcome: 'reserved' }) },
    )

    expect(outcome).toEqual({ outcome: 'sent' })
    expect(sendSpy).toHaveBeenCalledTimes(3)
    const messages = sendSpy.mock.calls.map((call) => call[1])
    expect(messages).toEqual([
      '@Viewer Alpha-1 pack=1/4',
      '@Viewer Alpha-2 pack=2/4',
      '@Viewer Alpha-3 pack=3/4',
    ])
    // 各 segment 確定後に cursor が順に永続化される（再開時に同じ draw の
    // snapshot から同じ本文を再構成できる前提）。
    expect(mocks.advanceChatNotificationDeliveryCursor.mock.calls.map((call) => call[1]))
      .toEqual([1, 2, 3])
  })
})
