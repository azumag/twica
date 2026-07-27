import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendChatAnnouncement } from '@/lib/services/eventsub-redemption'
import { TwitchChatService } from '@/lib/twitch/chat-service'
import { logger } from '@/lib/logger.server'

/**
 * `sendChatAnnouncement` の `duplicate → skipped` 変換を直接検証する。
 *
 * レビュー指摘（#842/#843）: この変換は eventsub-replay-route.test.ts にも
 * chat-service.test.ts にもテストが無い盲点だった。前者は `sendChatAnnouncement`
 * 自体を丸ごとモックしており実装を通らず、後者は分類側（chat-service.ts）だけを
 * 見ていて呼び出し元での写し替えを検証していない。ここでは
 * `TwitchChatService.prototype.sendChatMessageDetailed` だけを spy し、
 * `buildMessage` 等は実装のまま動かして本物の `sendChatAnnouncement` を呼ぶ。
 *
 * `snapshot` を渡すことで {num}/{unique}/{all} 系プレースホルダーのDBクエリを
 * 迂回する（eventsub-redemption.ts の `if (!snapshot && ...)` ガード）ため、
 * DBモックが不要になる。
 */
describe('sendChatAnnouncement: duplicate分類の写し替え (#842/#843)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const streamer = {
    id: 'streamer-1',
    chat_announcement_enabled: true,
    chat_announcement_template: '{user} got {card}',
    chat_announcement_multi_template: null,
    chat_announcement_multi_show_cards: false,
  }
  const card = {
    id: 'card-1',
    name: 'Alpha',
    description: null,
    image_url: null,
    rarity: 'common',
    drop_rate: 1,
  }
  const snapshot = { cardCount: 1, uniqueCount: 1, allCount: 10, newCardNames: [] }

  it('Twitchが重複として抑止した場合はDLQ行きのterminalではなくskippedを返す', async () => {
    vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'duplicate',
      reason: 'Your message was not sent because it is identical to the previous one you sent, less than 30 seconds ago.',
    })
    const infoSpy = vi.spyOn(logger, 'info')

    const outcome = await sendChatAnnouncement(
      '130871908',
      streamer,
      card,
      'Viewer',
      'viewer-1',
      undefined,
      undefined,
      snapshot,
    )

    // ここが実装の核心: 'duplicate' を握りつぶさず、呼び出し側(eventsub-replay-route)の
    // if連鎖（sent/skipped→ack、terminal→DLQ、それ以外→retryable）が正しくackできる
    // 'skipped' に写していること。写し忘れると未知の値としてretryableへ落ち、
    // Twitchが必ず再拒否する本文を再試行し続ける。
    expect(outcome).toEqual({ outcome: 'skipped' })

    // DLQ・エラー報告の対象外であることも合わせて確認する
    // （'terminal'/'aborted'ならDLQ、'duplicate'のままならreportErrorに渡り得る）
    expect(infoSpy).toHaveBeenCalledWith(
      'Chat announcement suppressed as duplicate by Twitch',
      expect.objectContaining({ streamerId: 'streamer-1', cardName: 'Alpha' }),
    )
  })

  it('比較対象: 通常のterminal（AutoMod等）はskippedへ写さずそのまま返す', async () => {
    vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'terminal',
      reason: 'Twitch API 200: The message was held by AutoMod.',
    })

    const outcome = await sendChatAnnouncement(
      '130871908',
      streamer,
      card,
      'Viewer',
      'viewer-1',
      undefined,
      undefined,
      snapshot,
    )

    expect(outcome).toEqual({
      outcome: 'terminal',
      reason: 'Twitch API 200: The message was held by AutoMod.',
    })
  })

  it('送信成功時はsentをそのまま返す', async () => {
    vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })

    const outcome = await sendChatAnnouncement(
      '130871908',
      streamer,
      card,
      'Viewer',
      'viewer-1',
      undefined,
      undefined,
      snapshot,
    )

    expect(outcome).toEqual({ outcome: 'sent' })
  })
})
