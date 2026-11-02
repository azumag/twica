import { describe, expect, it } from 'vitest'
import {
  parseArgs,
  redactTailEvent,
  splitJsonObjects,
  summarizeTails,
} from '../../scripts/preview-real-redemption.mjs'

/**
 * scripts/preview-real-redemption.mjs は preview の実チャネルポイント交換を
 * ブラウザで実行するローカル専用ハーネスで、ブラウザ操作自体は実 preview でしか
 * 検証できない。ここでは実行結果の保存に関わる純粋関数を固定する。
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

  describe('parseArgs', () => {
    it('既定値を返し、範囲外・未知の引数を拒否する', () => {
      expect(parseArgs(['run', '--count', '3'])).toMatchObject({ command: 'run', opts: { count: 3, logs: 'on' } })
      expect(() => parseArgs(['run', '--count', '9'])).toThrow('count must be 1..5')
      expect(() => parseArgs(['run', '--url', 'https://example.com'])).toThrow('unknown or incomplete option')
      expect(() => parseArgs(['run', '--channel', 'Bad Name'])).toThrow('invalid channel login')
    })
  })
})
