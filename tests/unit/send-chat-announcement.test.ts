import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendChatAnnouncement } from '@/lib/services/eventsub-redemption'
import { TwitchChatService } from '@/lib/twitch/chat-service'
import { logger } from '@/lib/logger.server'
import { getDb } from '@/lib/db/client'

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
  const snapshot = {
    cardCount: 1,
    uniqueCount: 1,
    allCount: 10,
    newCardNames: [],
    newCardNamesResolved: true,
  }

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

  it('{newCardsOrNone} は初入手ありなら既存 {newCards} と同じ一覧を送る', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const beta = { ...card, id: 'card-2', name: 'Beta' }
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}|legacy={newCards}|count={newCardCount}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, beta], undefined,
      { ...snapshot, newCardNames: ['Alpha'] },
    )

    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=Alpha|legacy=Alpha|count=1')
  })

  it('{newCardsOrNone} はsnapshotで正常0件が確定している場合だけ「なし」を送る', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const beta = { ...card, id: 'card-2', name: 'Beta' }
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}|legacy={newCards}|count={newCardCount}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, beta], undefined, snapshot,
    )

    // legacy placeholders remain byte-for-byte compatible: empty {newCards} and numeric 0.
    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=なし|legacy=|count=0')
  })

  it('outbox snapshotが判定不能なら既存placeholderだけを維持し {newCardsOrNone} は空文字にする', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const beta = { ...card, id: 'card-2', name: 'Beta' }
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}|legacy={newCards}|count={newCardCount}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, beta], undefined,
      { ...snapshot, newCardNames: ['Alpha'], newCardNamesResolved: false },
    )

    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=|legacy=Alpha|count=1')
  })

  it('移行前outbox snapshotは判定成否fieldが無いため「なし」にせず空文字にする', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const beta = { ...card, id: 'card-2', name: 'Beta' }
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}|legacy={newCards}|count={newCardCount}',
      chat_announcement_multi_show_cards: true,
    }
    const legacySnapshot = {
      cardCount: snapshot.cardCount,
      uniqueCount: snapshot.uniqueCount,
      allCount: snapshot.allCount,
      newCardNames: snapshot.newCardNames,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, beta], undefined,
      legacySnapshot,
    )

    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=|legacy=|count=0')
  })

  it('multiShowCardsがOFFなら {newCardsOrNone} はsnapshotがあっても空文字になる', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const beta = { ...card, id: 'card-2', name: 'Beta' }
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}',
      chat_announcement_multi_show_cards: false,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, beta], undefined,
      { ...snapshot, newCardNames: ['Alpha'] },
    )

    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=')
  })

  it('初入手情報の取得失敗時は {newCardsOrNone} を「なし」と誤表示しない', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    vi.mocked(getDb).mockRejectedValueOnce(new Error('database unavailable'))
    const beta = { ...card, id: 'card-2', name: 'Beta' }
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}|legacy={newCards}|count={newCardCount}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, beta],
    )

    // Existing {newCardCount}=0 fallback is preserved; only the new placeholder stays blank.
    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=|legacy=|count=0')
  })

  it('当選カードの所持行が欠落して初入手判定不能な場合は {newCardsOrNone} を空文字にする', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const sql = vi.fn().mockResolvedValue([{ result: [{ count: 1, card: { id: card.id, is_active: true } }] }])
    vi.mocked(getDb).mockResolvedValue({ db: {}, sql } as never)
    const beta = { ...card, id: 'card-2', name: 'Beta' }
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}|legacy={newCards}|count={newCardCount}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, beta],
    )

    // The existing placeholders keep their historical partial-result behavior.
    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=|legacy=Alpha|count=1')
  })

  it('全当選カードの所持数が正常に取得できて既所有なら {newCardsOrNone} は「なし」になる', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const beta = { ...card, id: 'card-2', name: 'Beta' }
    const sql = vi.fn().mockResolvedValue([{
      result: [
        { count: 2, card: { id: card.id, is_active: true } },
        { count: 3, card: { id: beta.id, is_active: true } },
      ],
    }])
    vi.mocked(getDb).mockResolvedValue({ db: {}, sql } as never)
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}|legacy={newCards}|count={newCardCount}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, beta],
    )

    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=なし|legacy=|count=0')
  })

  it('同一N連で同じカードを2回引いても {newCardsOrNone} はカード名を1回だけ表示する', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const sql = vi.fn().mockResolvedValue([{ result: [{ count: 2, card: { id: card.id, is_active: true } }] }])
    vi.mocked(getDb).mockResolvedValue({ db: {}, sql } as never)
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, card],
    )

    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=Alpha')
  })

  it('RPCがdata:null/error:nullを返す判定不能時は {newCardsOrNone} を空文字にする', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const sql = vi.fn().mockResolvedValue([{ result: null }])
    vi.mocked(getDb).mockResolvedValue({ db: {}, sql } as never)
    const beta = { ...card, id: 'card-2', name: 'Beta' }
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, beta],
    )

    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=')
  })

  it.each([
    ['zero', 0],
    ['fractional', 1.5],
    ['string', '2'],
    ['below current draw count', 1],
  ])('invalid final count (%s) leaves {newCardsOrNone} empty', async (_label, count) => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const sql = vi.fn().mockResolvedValue([{ result: [{ count, card: { id: card.id, is_active: true } }] }])
    vi.mocked(getDb).mockResolvedValue({ db: {}, sql } as never)
    const multiStreamer = {
      ...streamer,
      chat_announcement_multi_template: 'new={newCardsOrNone}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', multiStreamer, card, 'Viewer', 'viewer-1', [card, card],
    )

    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=')
  })

  it('単発通知では {newCardsOrNone} は未指定のまま空文字になる', async () => {
    const sendSpy = vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'sent',
    })
    const singleStreamer = {
      ...streamer,
      chat_announcement_template: 'new={newCardsOrNone}',
      chat_announcement_multi_show_cards: true,
    }

    await sendChatAnnouncement(
      '130871908', singleStreamer, card, 'Viewer', 'viewer-1', undefined, undefined, snapshot,
    )

    expect(sendSpy).toHaveBeenCalledWith('130871908', 'new=')
  })
})
