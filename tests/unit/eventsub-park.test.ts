import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MaintenanceState } from '@/lib/maintenance/state'

/**
 * #694 Stage 4: parkEventSubNotification（EventSub notification の KV 退避）のテスト。
 *
 * Cloudflare コンテキストは環境依存のためモックで制御する。
 * eventsub-park.ts は動的 import で @opennextjs/cloudflare を解決するが、
 * vi.mock は動的 import にも適用される（tests/unit/db-client.test.ts と同じパターン）。
 */
const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
}))
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

async function importParkModule() {
  return await import('@/lib/maintenance/eventsub-park')
}

const BASE_MAINTENANCE_STATE: MaintenanceState = {
  mode: 'read-only',
  operationId: 'op-123',
}

describe('parkEventSubNotification (#694 Stage 4)', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getCloudflareContext.mockReset()
    // vi.resetModules() だけでは logger モックの呼び出し履歴（vi.fn().mock.calls）は
    // クリアされない（モジュールキャッシュのリセットと呼び出し履歴は別物のため）。
    // not.toHaveBeenCalled() で厳密に検証するテストがあるため、明示的にクリアする。
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('KVバインディングが取得できれば put を呼び true を返す', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { put } },
    })

    const { parkEventSubNotification } = await importParkModule()
    const { logger } = await import('@/lib/logger')

    const result = await parkEventSubNotification({
      messageId: 'msg-1',
      payload: { subscription: { type: 'channel.channel_points_custom_reward_redemption.add' }, event: { foo: 'bar' } },
      subscriptionType: 'channel.channel_points_custom_reward_redemption.add',
      maintenanceState: BASE_MAINTENANCE_STATE,
    })

    expect(result).toBe(true)
    expect(put).toHaveBeenCalledTimes(1)

    const [key, value, options] = put.mock.calls[0]
    // キーは maintenance:eventsub: プレフィックス + ISO8601タイムスタンプ + messageId
    expect(key).toMatch(/^maintenance:eventsub:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:msg-1$/)
    // TTLは7日間（秒）
    expect(options).toEqual({ expirationTtl: 7 * 24 * 60 * 60 })

    const parsed = JSON.parse(value)
    expect(parsed).toMatchObject({
      messageId: 'msg-1',
      subscriptionType: 'channel.channel_points_custom_reward_redemption.add',
      payload: { subscription: { type: 'channel.channel_points_custom_reward_redemption.add' }, event: { foo: 'bar' } },
      maintenanceMode: 'read-only',
      maintenanceOperationId: 'op-123',
    })
    expect(typeof parsed.receivedAt).toBe('string')

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[maintenance:eventsub] parked message id=msg-1')
    )
  })

  it('payload.event.user_input はKVへ保存する前に除去され、他のフィールドは保持される（issue #695代替 項目3: payload最小化）', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { put } },
    })

    const { parkEventSubNotification } = await importParkModule()

    await parkEventSubNotification({
      messageId: 'msg-2',
      payload: {
        subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
        event: {
          id: 'redemption-1',
          user_id: 'user-1',
          user_name: 'viewer',
          user_input: '視聴者が自由入力した個人情報を含みうるテキスト',
          reward: { id: 'reward-1', title: 'ガチャ' },
        },
      },
      subscriptionType: 'channel.channel_points_custom_reward_redemption.add',
      maintenanceState: BASE_MAINTENANCE_STATE,
    })

    const [, value] = put.mock.calls[0]
    const parsed = JSON.parse(value)
    // event.user_input は除去
    expect(parsed.payload.event).not.toHaveProperty('user_input')
    // リプレイに必要な他のフィールドはそのまま残る
    expect(parsed.payload.event).toEqual({
      id: 'redemption-1',
      user_id: 'user-1',
      user_name: 'viewer',
      reward: { id: 'reward-1', title: 'ガチャ' },
    })
    // event以外のトップレベルフィールド（subscription等）も維持される
    expect(parsed.payload.subscription).toEqual({
      type: 'channel.channel_points_custom_reward_redemption.add',
    })
  })

  it('user_input を含まないpayloadはそのまま保存される（余計な変換をしない）', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { put } },
    })

    const { parkEventSubNotification } = await importParkModule()

    await parkEventSubNotification({
      messageId: 'msg-3',
      payload: { subscription: { type: 'channel.raid' }, event: { viewers: 5 } },
      subscriptionType: 'channel.raid',
      maintenanceState: BASE_MAINTENANCE_STATE,
    })

    const [, value] = put.mock.calls[0]
    const parsed = JSON.parse(value)
    expect(parsed.payload).toEqual({ subscription: { type: 'channel.raid' }, event: { viewers: 5 } })
  })

  it('payload自体がオブジェクトでない場合は防御的にそのまま保存する（未知のsubscription typeを全量退避する既存方針を壊さない）', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { put } },
    })

    const { parkEventSubNotification } = await importParkModule()

    await parkEventSubNotification({
      messageId: 'msg-4',
      payload: 'not-an-object',
      subscriptionType: 'unknown.type',
      maintenanceState: BASE_MAINTENANCE_STATE,
    })

    const [, value] = put.mock.calls[0]
    const parsed = JSON.parse(value)
    expect(parsed.payload).toBe('not-an-object')
  })

  it('payloadはオブジェクトだがeventがオブジェクトでない・存在しない場合も防御的にそのまま保存する', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { put } },
    })

    const { parkEventSubNotification } = await importParkModule()

    await parkEventSubNotification({
      messageId: 'msg-5',
      payload: { subscription: { type: 'unknown.type' }, event: 'not-an-object' },
      subscriptionType: 'unknown.type',
      maintenanceState: BASE_MAINTENANCE_STATE,
    })

    const [, value] = put.mock.calls[0]
    const parsed = JSON.parse(value)
    expect(parsed.payload).toEqual({ subscription: { type: 'unknown.type' }, event: 'not-an-object' })
  })

  it('KVバインディングが未取得（Workers外）なら false を返し warn ログを出す', async () => {
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in workers'))

    const { parkEventSubNotification } = await importParkModule()
    const { logger } = await import('@/lib/logger')

    const result = await parkEventSubNotification({
      messageId: 'msg-2',
      payload: { event: {} },
      subscriptionType: 'channel.raid',
      maintenanceState: BASE_MAINTENANCE_STATE,
    })

    expect(result).toBe(false)
    // データロスのためwarnではなくerror（errorsテーブル→GitHub Issue自動起票経路）で記録する
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[maintenance:eventsub] KV binding unavailable, dropping message id=msg-2')
    )
  })

  it('env に RATE_LIMIT_KV バインディングが存在しない場合も false を返す', async () => {
    mocks.getCloudflareContext.mockResolvedValue({ env: {} })

    const { parkEventSubNotification } = await importParkModule()
    const { logger } = await import('@/lib/logger')

    const result = await parkEventSubNotification({
      messageId: 'msg-3',
      payload: { event: {} },
      subscriptionType: 'channel.raid',
      maintenanceState: BASE_MAINTENANCE_STATE,
    })

    expect(result).toBe(false)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('KV binding unavailable, dropping message id=msg-3')
    )
  })

  it('KVのput失敗時はfalseを返しデータロスをerrorログに記録する（例外を再送出しない）', async () => {
    const put = vi.fn().mockRejectedValue(new Error('KV unavailable'))
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: { put } },
    })

    const { parkEventSubNotification } = await importParkModule()
    const { logger } = await import('@/lib/logger')

    const result = await parkEventSubNotification({
      messageId: 'msg-4',
      payload: { event: {} },
      subscriptionType: 'channel.channel_points_custom_reward_redemption.add',
      maintenanceState: BASE_MAINTENANCE_STATE,
    })

    expect(result).toBe(false)
    // データロスのためwarnではなくerror（errorsテーブル→GitHub Issue自動起票経路）で記録する
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[maintenance:eventsub] failed to park message id=msg-4'),
      expect.objectContaining({ error: 'KV unavailable' })
    )
  })
})

/**
 * Issue #787 Stage 2: リプレイ機構向けに追加した list/get/delete のテスト。
 * parkEventSubNotification と同じ getCloudflareContext モックパターンを使う。
 */
describe('listParkedEventSubNotifications (#787 Stage 2)', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getCloudflareContext.mockReset()
    // vi.resetModules() だけでは logger モックの呼び出し履歴（vi.fn().mock.calls）は
    // クリアされない（モジュールキャッシュのリセットと呼び出し履歴は別物のため）。
    // not.toHaveBeenCalled() で厳密に検証するテストがあるため、明示的にクリアする。
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('KVから取得したキーをJSON.parseしてrecordの一覧を返す', async () => {
    const record1 = {
      messageId: 'msg-1',
      subscriptionType: 'channel.channel_points_custom_reward_redemption.add',
      payload: { event: { foo: 'bar' } },
      receivedAt: '2026-07-01T00:00:00.000Z',
      maintenanceMode: 'read-only',
      maintenanceOperationId: 'op-1',
    }
    const record2 = {
      messageId: 'msg-2',
      subscriptionType: 'channel.raid',
      payload: { event: { baz: 'qux' } },
      receivedAt: '2026-07-01T00:01:00.000Z',
      maintenanceMode: 'read-only',
      maintenanceOperationId: 'op-1',
    }

    const list = vi.fn().mockResolvedValue({
      keys: [{ name: 'maintenance:eventsub:key-1' }, { name: 'maintenance:eventsub:key-2' }],
      list_complete: true,
      cursor: undefined,
    })
    const get = vi.fn((key: string) => {
      if (key === 'maintenance:eventsub:key-1') return Promise.resolve(JSON.stringify(record1))
      if (key === 'maintenance:eventsub:key-2') return Promise.resolve(JSON.stringify(record2))
      return Promise.resolve(null)
    })
    mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { list, get } } })

    const { listParkedEventSubNotifications } = await importParkModule()

    const result = await listParkedEventSubNotifications({})

    expect(list).toHaveBeenCalledWith({ prefix: 'maintenance:eventsub:', cursor: undefined, limit: undefined })
    expect(result.listComplete).toBe(true)
    expect(result.cursor).toBeUndefined()
    expect(result.entries).toEqual([
      { key: 'maintenance:eventsub:key-1', record: record1 },
      { key: 'maintenance:eventsub:key-2', record: record2 },
    ])
  })

  it('cursor/limitをKVのlistへそのまま渡し、続きのcursorを返す', async () => {
    const list = vi.fn().mockResolvedValue({
      keys: [],
      list_complete: false,
      cursor: 'next-cursor',
    })
    mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { list, get: vi.fn() } } })

    const { listParkedEventSubNotifications } = await importParkModule()
    const result = await listParkedEventSubNotifications({ cursor: 'incoming-cursor', limit: 10 })

    expect(list).toHaveBeenCalledWith({ prefix: 'maintenance:eventsub:', cursor: 'incoming-cursor', limit: 10 })
    expect(result.cursor).toBe('next-cursor')
    expect(result.listComplete).toBe(false)
    expect(result.entries).toEqual([])
  })

  it('1件の破損JSON（パース失敗）はlogger.errorでログしてスキップし、他のエントリは正常に返す', async () => {
    const validRecord = {
      messageId: 'msg-valid',
      subscriptionType: 'channel.raid',
      payload: { event: {} },
      receivedAt: '2026-07-01T00:00:00.000Z',
      maintenanceMode: 'read-only',
      maintenanceOperationId: 'op-1',
    }

    const list = vi.fn().mockResolvedValue({
      keys: [
        { name: 'maintenance:eventsub:key-corrupted' },
        { name: 'maintenance:eventsub:key-valid' },
      ],
      list_complete: true,
      cursor: undefined,
    })
    const get = vi.fn((key: string) => {
      if (key === 'maintenance:eventsub:key-corrupted') return Promise.resolve('{not valid json')
      if (key === 'maintenance:eventsub:key-valid') return Promise.resolve(JSON.stringify(validRecord))
      return Promise.resolve(null)
    })
    mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { list, get } } })

    const { listParkedEventSubNotifications } = await importParkModule()
    const { logger } = await import('@/lib/logger')

    const result = await listParkedEventSubNotifications({})

    // 破損データは除外され、全体は継続して正常なエントリを返す
    expect(result.entries).toEqual([{ key: 'maintenance:eventsub:key-valid', record: validRecord }])
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to parse parked record - corrupted data, skipping key=maintenance:eventsub:key-corrupted'),
      expect.anything()
    )
  })

  it('getがnullを返す（list後にTTL失効等で消えた）キーはエラーにせず単純にスキップする', async () => {
    const list = vi.fn().mockResolvedValue({
      keys: [{ name: 'maintenance:eventsub:key-gone' }],
      list_complete: true,
      cursor: undefined,
    })
    const get = vi.fn().mockResolvedValue(null)
    mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { list, get } } })

    const { listParkedEventSubNotifications } = await importParkModule()
    const { logger } = await import('@/lib/logger')

    const result = await listParkedEventSubNotifications({})

    expect(result.entries).toEqual([])
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('KVバインディングが取得できない場合は空の結果を返しlogger.errorする', async () => {
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in workers'))

    const { listParkedEventSubNotifications } = await importParkModule()
    const { logger } = await import('@/lib/logger')

    const result = await listParkedEventSubNotifications({})

    expect(result).toEqual({ entries: [], cursor: undefined, listComplete: true })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[maintenance:eventsub] KV binding unavailable, cannot list parked notifications')
    )
  })
})

describe('deleteParkedEventSubNotification (#787 Stage 2)', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getCloudflareContext.mockReset()
    // vi.resetModules() だけでは logger モックの呼び出し履歴（vi.fn().mock.calls）は
    // クリアされない（モジュールキャッシュのリセットと呼び出し履歴は別物のため）。
    // not.toHaveBeenCalled() で厳密に検証するテストがあるため、明示的にクリアする。
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('KVバインディングが取得できればdeleteを呼ぶ', async () => {
    const del = vi.fn().mockResolvedValue(undefined)
    mocks.getCloudflareContext.mockResolvedValue({ env: { RATE_LIMIT_KV: { delete: del } } })

    const { deleteParkedEventSubNotification } = await importParkModule()
    await deleteParkedEventSubNotification('maintenance:eventsub:key-1')

    expect(del).toHaveBeenCalledWith('maintenance:eventsub:key-1')
  })

  it('KVバインディングが取得できない場合はwarnログのみで例外を投げない（TTLでいずれ消えるため致命的ではない）', async () => {
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in workers'))

    const { deleteParkedEventSubNotification } = await importParkModule()
    const { logger } = await import('@/lib/logger')

    await expect(deleteParkedEventSubNotification('maintenance:eventsub:key-1')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[maintenance:eventsub] KV binding unavailable, cannot delete parked notification key=maintenance:eventsub:key-1')
    )
  })
})
