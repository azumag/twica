import { describe, expect, it, vi } from 'vitest'
import {
  parseArgs,
  redactTailEvent,
  splitJsonObjects,
  summarizeTails,
  correlateRedemption,
  chatMatches,
  tailAlive,
  waitTailsReady,
} from '../../scripts/preview-real-redemption.mjs'

/**
 * scripts/preview-real-redemption.mjs は preview の実チャネルポイント交換を
 * ブラウザで実行するローカル専用ハーネスで、ブラウザ操作自体は実 preview でしか
 * 検証できない。ここでは実行結果の保存と合格判定に関わる純粋関数（redact、
 * tail 集計、overlay/履歴/チャットの照合ゲート）を固定する。
 * 特に wrangler tail の event はリクエストヘッダー（Cookie、EventSub 署名）を含むため、
 * 保存前に落とすことを回帰として持つ。
 */
describe('preview-real-redemption', () => {
  describe('redactTailEvent', () => {
    const event = {
      scriptName: 'twica-preview',
      eventTimestamp: Date.UTC(2026, 10, 2, 1, 48, 40),
      outcome: 'ok',
      event: {
        request: {
          url: 'https://twica-preview.example/api/twitch/eventsub?x=1',
          method: 'POST',
          headers: {
            cookie: 'twica_session=SECRET_SESSION',
            'twitch-eventsub-message-signature': 'sha256=SECRET_SIGNATURE',
          },
        },
        response: { status: 200 },
      },
      logs: [{ level: 'log', message: ['Gacha success'] }],
      exceptions: [],
    }

    it('ヘッダーとクエリを保存しない', () => {
      const redacted = redactTailEvent(event)
      expect(JSON.stringify(redacted)).not.toMatch(/SECRET_|cookie|signature|x=1/i)
      expect(redacted).toEqual({
        worker: 'twica-preview',
        at: '2026-11-02T01:48:40.000Z',
        outcome: 'ok',
        method: 'POST',
        path: '/api/twitch/eventsub',
        status: 200,
        queue: null,
        cron: null,
        logs: ['log: ["Gacha success"]'],
        exceptions: [],
      })
    })

    it('request の無い queue / cron event も扱える', () => {
      expect(
        redactTailEvent({ scriptName: 'twica-chat-delivery-preview', outcome: 'exception', event: { queue: 'q' }, exceptions: [{ name: 'Error', message: 'boom' }] }),
      ).toMatchObject({ path: null, status: null, queue: 'q', exceptions: ['Error: boom'] })
    })
  })

  describe('splitJsonObjects', () => {
    it('chunk の途中で切れた event は次の chunk へ残す', () => {
      const first = splitJsonObjects('{"a":{"b":1}}\n{"c":')
      expect(first.objects).toEqual(['{"a":{"b":1}}'])
      const second = splitJsonObjects(`${first.rest}2}\n`)
      expect(second.objects).toEqual(['{"c":2}'])
      expect(second.rest).toBe('\n')
    })

    it('文字列中の波括弧とエスケープを区切りと誤認しない', () => {
      const text = '{"m":"a } { \\" }"}'
      expect(splitJsonObjects(text).objects).toEqual([text])
      expect(JSON.parse(splitJsonObjects(text).objects[0])).toEqual({ m: 'a } { " }' })
    })
  })

  describe('summarizeTails', () => {
    it('EventSub 受信、エラー、5xx、再試行ログを Worker 横断で集計する', () => {
      const tails = [
        {
          worker: 'twica-preview',
          stderr: '',
          events: [
            { worker: 'twica-preview', at: 't1', outcome: 'ok', path: '/api/twitch/eventsub', status: 200, logs: ['log: "channel.channel_points_custom_reward_redemption.add"'], exceptions: [] },
            { worker: 'twica-preview', at: 't2', outcome: 'ok', path: '/api/gacha-history', status: 503, logs: ['error: "db down"'], exceptions: [] },
          ],
        },
        {
          worker: 'twica-chat-delivery-preview',
          stderr: '',
          events: [
            { worker: 'twica-chat-delivery-preview', at: 't3', outcome: 'ok', path: null, status: null, logs: ['info: "[postRedemptionNotify] chat announcement retry scheduled"'], exceptions: [] },
          ],
        },
      ]
      const summary = summarizeTails(tails)
      expect(summary.events).toEqual({ 'twica-preview': 2, 'twica-chat-delivery-preview': 1 })
      expect(summary.eventsub).toEqual([{ at: 't1', status: 200, outcome: 'ok' }])
      expect(summary.redemptionLogs).toBe(1)
      expect(summary.http5xx).toEqual([{ worker: 'twica-preview', at: 't2', path: '/api/gacha-history', status: 503 }])
      expect(summary.errorLogs).toHaveLength(1)
      expect(summary.retryLogs).toHaveLength(1)
    })
  })

  it('2xx を返した後の canceled（呼び出し元の本文 cancel）は失敗に数えない', () => {
    const base = { logs: [], exceptions: [], method: 'POST', queue: null, cron: null }
    const summary = summarizeTails([
      {
        worker: 'twica-overlay-realtime-preview',
        stderr: '',
        events: [
          { ...base, worker: 'twica-overlay-realtime-preview', at: 't1', outcome: 'canceled', path: '/internal/v1/rooms/s/publish', status: 202 },
          { ...base, worker: 'twica-overlay-realtime-preview', at: 't2', outcome: 'canceled', path: '/internal/v1/rooms/s/publish', status: null },
          { ...base, worker: 'twica-overlay-realtime-preview', at: 't3', outcome: 'exceededCpu', path: '/publish', status: 202 },
          // 例外を許す根拠は publish 経路（discardResponseBody）だけなので、
          // 他パスの canceled は 2xx でも失敗として残る。
          { ...base, worker: 'twica-preview', at: 't4', outcome: 'canceled', path: '/api/gacha-history', status: 200 },
        ],
      },
    ])
    expect(summary.canceledAfterResponse).toEqual([{ worker: 'twica-overlay-realtime-preview', at: 't1', path: '/internal/v1/rooms/s/publish', status: 202 }])
    expect(summary.nonOk.map((event: { at: string }) => event.at)).toEqual(['t2', 't3', 't4'])
  })

  describe('parseArgs', () => {
    it('既定値を返し、範囲外・未知の引数を拒否する', () => {
      expect(parseArgs(['run', '--count', '3'])).toMatchObject({ command: 'run', opts: { count: 3, logs: 'on' } })
      expect(() => parseArgs(['run', '--count', '9'])).toThrow('count must be 1..5')
      expect(() => parseArgs(['run', '--url', 'https://example.com'])).toThrow('unknown or incomplete option')
      expect(() => parseArgs(['run', '--channel', 'Bad Name'])).toThrow('invalid channel login')
    })

    it('--user は表示名（非 ASCII 可）を小文字にそろえて受け付け、空白や @ を含む値は拒否する', () => {
      expect(parseArgs(['run', '--user', 'テスト']).opts.user).toBe('テスト')
      expect(parseArgs(['run', '--user', 'TestUser']).opts.user).toBe('testuser')
      expect(() => parseArgs(['run', '--user', 'a b'])).toThrow('invalid user display name')
      expect(() => parseArgs(['run', '--user', '@testuser'])).toThrow('invalid user display name')
    })
  })
})

// Synthetic identities only: these cases exercise the gate, not a real Twitch account.
describe('redemption correlation gate', () => {
  const since = Date.UTC(2026, 10, 2)
  const row = { id: 'history-new', user: 'testuser', card: 'Card B', redeemedAt: new Date(since + 100).toISOString() }
  const display = { instance: '2', card: 'Card B', user: 'testuser', observedAt: since + 500 }
  const prior = new Set(['1'])

  it('accepts one fresh matching display and history', () => {
    expect(correlateRedemption([display], [row], 'testuser', since, prior)).toEqual({ overlay: display, history: row, nameHidden: false })
    expect(chatMatches('@testuser が【コモン】Card B を獲得しました！', row, 'testuser')).toBe(true)
  })

  it('accepts a portrait-layout display whose username text is not rendered', () => {
    // 縦長/imageOnly レイアウトでは「X が引いたカード」とカード名の帯が描画されず
    // sample.user は null になる（issue #2004）。カード名は img.alt 由来で残るため、
    // ユーザー名非表示の表示だけはカード名で照合し、nameHidden を記録する。
    const portrait = { ...display, user: null, text: '' }
    expect(correlateRedemption([portrait], [row], 'testuser', since, prior))
      .toEqual({ overlay: portrait, history: row, nameHidden: true })
  })

  it('rejects a name-hidden display for a different card, and ambiguous hidden displays', () => {
    // alt 由来のカード名が履歴と一致しない表示は他人の引きの可能性があるため照合しない。
    expect(correlateRedemption([{ ...display, user: null, card: 'Card A' }], [row], 'testuser', since, prior)).toBeNull()
    // 名前非表示の表示が2枚あると同一ユーザー表示の取り違えと区別できないため不合格。
    const portrait = { ...display, user: null }
    expect(correlateRedemption([portrait, { ...portrait, instance: '3' }], [row], 'testuser', since, prior)).toBeNull()
    // ユーザー名が描画されているのに別ユーザーなら従来どおり不合格（退行なし）。
    expect(correlateRedemption([{ ...display, user: 'otheruser' }], [row], 'testuser', since, prior)).toBeNull()
  })

  it.each([
    { ...display, card: 'Card A' },
    { ...display, user: 'otheruser' },
    { ...display, instance: '1' },
    { ...display, instance: null },
    { ...display, observedAt: since - 1 },
  ])('rejects a different or old overlay: %j', (sample) => {
    expect(correlateRedemption([sample], [row], 'testuser', since, prior)).toBeNull()
  })

  it('accepts history slightly before click within clock-skew tolerance', () => {
    // DB のサーバ時計とローカル時計のずれを許容する（knownIds が古い行を除外済み）。
    const skewed = { ...row, redeemedAt: new Date(since - 2_000).toISOString() }
    expect(correlateRedemption([display], [skewed], 'testuser', since, prior)).toEqual({ overlay: display, history: skewed, nameHidden: false })
  })

  it('rejects old history, another recipient, and ambiguous simultaneous draws', () => {
    for (const rows of [
      [{ ...row, redeemedAt: new Date(since - 5_000).toISOString() }],
      [{ ...row, user: 'otheruser' }],
      [row, { ...row, id: 'second-draw' }],
    ]) expect(correlateRedemption([display], rows, 'testuser', since, prior)).toBeNull()
    expect(correlateRedemption([display, { ...display, instance: '3' }], [row], 'testuser', since, prior)).toBeNull()
  })

  it('rejects chat for another recipient or a card with only a shared prefix', () => {
    expect(chatMatches('@otheruser が【コモン】Card B を獲得しました！', row, 'testuser')).toBe(false)
    expect(chatMatches('@testuser2 が【コモン】Card B を獲得しました！', row, 'testuser')).toBe(false)
    expect(chatMatches('@testuser が【コモン】Card B2 を獲得しました！', row, 'testuser')).toBe(false)
    expect(chatMatches('@testuser が【コモン】Card B を獲得しました！', { ...row, card: 'B' }, 'testuser')).toBe(false)
  })
})

describe('tail observation gate', () => {
  const event = { at: '2026-11-02T00:00:01Z', outcome: 'ok', path: '/api/twitch/eventsub', status: 200, logs: [], exceptions: [] }
  const tail = { worker: 'test-worker', stderr: '', failed: false, child: { exitCode: null, signalCode: null, killed: false }, events: [event] }

  it('requires a live process and positive receipt evidence', () => {
    expect(summarizeTails([tail]).connected['test-worker']).toBe(true)
    expect(summarizeTails([{ ...tail, events: [] }]).connected['test-worker']).toBe(false)
  })

  it.each([
    { ...tail, failed: true },
    { ...tail, child: { ...tail.child, exitCode: 1 } },
    { ...tail, child: { ...tail.child, exitCode: 0 } },
    { ...tail, child: { ...tail.child, signalCode: 'SIGTERM' } },
    { ...tail, child: { ...tail.child, killed: true } },
    { ...tail, child: undefined },
  ])('does not let a successful HTTP event conceal loss of observation', (stopped) => {
    expect(tailAlive(stopped)).toBe(false)
    expect(summarizeTails([stopped]).connected['test-worker']).toBe(false)
  })
})


describe('tail startup race', () => {
  it('repeats safe probes when the request before tail attachment was lost', async () => {
    vi.useFakeTimers()
    const tail = { worker: 'test-worker', failed: false, child: { exitCode: null, signalCode: null, killed: false }, events: [] as object[] }
    const probe = vi.fn(async () => {
      if (probe.mock.calls.length === 2) tail.events.push({})
    })
    try {
      const ready = waitTailsReady([tail], probe)
      await vi.advanceTimersByTimeAsync(10_500)
      await ready
      expect(probe).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to probe or redeem after an early tail exit', async () => {
    const probe = vi.fn()
    await expect(waitTailsReady([{ failed: true }], probe)).rejects.toThrow('stopped before redemption')
    expect(probe).not.toHaveBeenCalled()
  })
})
