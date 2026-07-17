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
