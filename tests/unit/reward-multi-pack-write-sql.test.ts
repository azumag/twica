/**
 * Issue #1994 (PR #1995 独立レビュー必須1〜3): 複数パック割り当ての「実際に発行される SQL」を検証する。
 *
 * 背景: 既存の単体テストは db.update(...).set(values) に渡したオブジェクトしか見ていなかった。
 * Drizzle は **テーブル定義にある列だけ** を SET / INSERT 列 / RETURNING に描画し、定義に無い
 * キーは黙って捨てる。そのため本体定義（streamers / streamerAdditionalGachaRewards）へ
 * channel_point_pack_names / reward_pack_names を渡しても、SQL には一度も出ていなかった
 * （= 配列列が DB に書かれない）のに、テストは緑のままだった。
 *
 * このファイルは `drizzle.mock({ schema })` の本物のクエリビルダーを Proxy で包み、
 * await された時点で `toSQL()` を描画してログに積んでから、テストが用意した行（または
 * PostgreSQL 形式のエラー）を返す。ルートハンドラが実際に組み立てた SQL テキストと
 * パラメータを assert できるので、列が SQL から落ちる種類の退行を確実に検出できる。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '@/lib/db/schema'
import { getDb } from '@/lib/db/client'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { checkRateLimit, getRateLimitIdentifier } from '@/lib/rate-limit'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { getUserPlan } from '@/lib/plan'
import { checkCollectionHasActiveCards, checkCollectionsHaveActiveCards } from '@/lib/collections/collection-existence'
import { DEFAULT_PACK_SENTINEL } from '@/lib/validation/collection-name'
import { hasScope, getTwitchAccessToken } from '@/lib/twitch/token-manager'
import { POST as settingsPOST } from '@/app/api/streamer/settings/route'
import {
  GET as additionalRewardsGET,
  POST as additionalRewardsPOST,
  PUT as additionalRewardsPUT,
} from '@/app/api/streamer/additional-rewards/route'
import { GET as bootstrapGET } from '@/app/api/twitch/channel-point-bootstrap/route'
import { __resetTwitchAppTokenForTests } from '@/lib/twitch/app-token'

vi.mock('@/lib/session')
vi.mock('@/lib/rate-limit')
vi.mock('@/lib/csrf')
vi.mock('@/lib/request-validation')
vi.mock('@/lib/plan')
// パック存在検査（cards への SELECT）は本テストの対象外。SQL ログを対象クエリだけに
// 保つため、存在すると答えるスタブに差し替える（他のエクスポートは実体のまま）。
vi.mock('@/lib/collections/collection-existence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/collections/collection-existence')>()),
  checkCollectionHasActiveCards: vi.fn(),
  // 複数パックの存在検査はバッチ版へ集約済み（Issue #1996）。パック存在ありと答えるスタブ。
  checkCollectionsHaveActiveCards: vi.fn(),
}))
vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn(),
  getTwitchAccessToken: vi.fn(),
}))
vi.mock('@/lib/twitch/channel-points-access', () => ({
  getChannelPointsAccessState: vi.fn(async () => ({ capability: 'available', checkedAt: null })),
  persistChannelPointsCapability: vi.fn(),
  recordChannelPointsApiFailure: vi.fn(),
}))

interface RenderedQuery {
  sql: string
  params: unknown[]
}

/** SQL ごとに返す行を決める（throw すると DB エラーとして reject される）。 */
type Responder = (query: RenderedQuery) => unknown[]

/**
 * drizzle.mock() の本物のビルダーを包み、await（then）の瞬間に toSQL() を描画して
 * ログへ積む DB スタブ。メソッドチェーンの戻り値（PgUpdateBuilder → PgUpdateBase など、
 * 別オブジェクトになるものを含む）は全て包み直して返すため、どの段で await されても捕捉できる。
 */
function createSqlCapturingDb(responder: Responder) {
  const real = drizzle.mock({ schema })
  const log: RenderedQuery[] = []

  const wrap = (target: object): any =>
    new Proxy(target, {
      get(t, prop) {
        if (prop === 'then') {
          const toSQL = (t as { toSQL?: () => RenderedQuery }).toSQL
          if (typeof toSQL !== 'function') return undefined
          return (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) => {
            const rendered = toSQL.call(t)
            log.push({ sql: rendered.sql, params: rendered.params })
            return Promise.resolve()
              .then(() => responder(rendered))
              .then(onFulfilled, onRejected)
          }
        }
        const value = Reflect.get(t, prop, t)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const result = value.apply(t, args)
          return result !== null && typeof result === 'object' && prop !== 'toSQL' && prop !== 'getSQL'
            ? wrap(result)
            : result
        }
      },
    })

  const db = {
    select: (...args: unknown[]) => wrap((real.select as any)(...args)),
    insert: (...args: unknown[]) => wrap((real.insert as any)(...args)),
    update: (...args: unknown[]) => wrap((real.update as any)(...args)),
    delete: (...args: unknown[]) => wrap((real.delete as any)(...args)),
  }
  return { db, log }
}

function installSqlDb(responder: Responder) {
  const capture = createSqlCapturingDb(responder)
  vi.mocked(getDb).mockResolvedValue({ db: capture.db, sql: {} } as any)
  return capture.log
}

/** postgres.js の PostgresError と同じ形の 42703（undefined_column）。 */
function missingColumnError(column: string, relation: string) {
  return Object.assign(new Error(`column "${column}" of relation "${relation}" does not exist`), {
    code: '42703',
  })
}

const isUpdate = (q: RenderedQuery, table: string) => q.sql.startsWith(`update "${table}"`)
const isInsert = (q: RenderedQuery, table: string) => q.sql.startsWith(`insert into "${table}"`)
const isSelectFrom = (q: RenderedQuery, table: string) => q.sql.startsWith('select') && q.sql.includes(`from "${table}"`)
/** UPDATE 文の SET 句（WHERE より前）だけを切り出す。RETURNING / WHERE の列と区別するため。 */
const setClause = (q: RenderedQuery) => q.sql.slice(q.sql.indexOf(' set '), q.sql.indexOf(' where '))
/** RETURNING 句だけを切り出す。 */
const returningClause = (q: RenderedQuery) => q.sql.slice(q.sql.indexOf(' returning '))

const STREAMER_ID = '11111111-1111-4111-8111-111111111111'
const TWITCH_USER_ID = 'twitch-user-1'
const MAIN_REWARD_ID = '22222222-2222-4222-8222-222222222222'
const ADDITIONAL_REWARD_ID = '33333333-3333-4333-8333-333333333333'

function jsonRequest(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.mocked(getDb).mockReset()
  vi.mocked(getSession).mockResolvedValue({
    twitchUserId: TWITCH_USER_ID,
    twitchUsername: 'streamer',
    twitchDisplayName: 'Streamer',
    twitchProfileImageUrl: null,
    broadcasterType: 'affiliate',
    expiresAt: Date.now() + 60_000,
    version: 1,
  } as any)
  vi.mocked(canUseStreamerFeatures).mockReturnValue(true)
  vi.mocked(checkRateLimit).mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: 0 } as any)
  vi.mocked(getRateLimitIdentifier).mockResolvedValue('id' as any)
  vi.mocked(validateCSRFToken).mockResolvedValue({ valid: true } as any)
  vi.mocked(validateContentType).mockReturnValue(null as any)
  vi.mocked(getUserPlan).mockResolvedValue('support' as any)
  vi.mocked(checkCollectionHasActiveCards).mockResolvedValue('present' as any)
  // 呼び出し名に関わらず常に exists を返す（存在検査は本テストの対象外）。
  vi.mocked(checkCollectionsHaveActiveCards).mockImplementation(async (_id: string, names: readonly string[]) =>
    new Map(names.map((name) => [name, 'exists' as const])))
})

// ---------------------------------------------------------------------------
// 必須1: POST /api/streamer/settings（メイン報酬）
// ---------------------------------------------------------------------------

/** settings ルートの SELECT（所有権 + 現在値、パック割り当て現在値）へ返す行。 */
function settingsSelectRows(q: RenderedQuery): unknown[] {
  if (q.sql.includes('"channel_point_pack_names"')) {
    return [{ channel_point_pack_names: [] }]
  }
  return [{
    id: STREAMER_ID,
    channel_point_collection_name: null,
    card_pack_names: ['A', 'B'],
    pack_rarity_weights: null,
    pack_album_grid_sizes: null,
  }]
}

describe('POST /api/streamer/settings: 発行 SQL (Issue #1994 必須1)', () => {
  it('パック割り当ての保存は、配列列・旧列ミラー・同時に送った他項目を同じ1本の UPDATE で書く', async () => {
    const log = installSqlDb((q) => (q.sql.startsWith('select') ? settingsSelectRows(q) : []))

    const res = await settingsPOST(jsonRequest('http://localhost/api/streamer/settings', 'POST', {
      streamerId: STREAMER_ID,
      channelPointRewardId: MAIN_REWARD_ID,
      channelPointRewardName: 'Gacha',
      channelPointCollectionNames: ['A', 'B'],
    }))

    expect(res.status).toBe(200)
    const updates = log.filter((q) => isUpdate(q, 'streamers'))
    expect(updates).toHaveLength(1)
    const set = setClause(updates[0])
    expect(set).toContain('"channel_point_pack_names" = ')
    expect(set).toContain('"channel_point_collection_name" = ')
    // 狭い定義へ切り替えたことで他の列が落ちる「逆向きの必須1」の回帰検知。
    expect(set).toContain('"channel_point_reward_id" = ')
    expect(set).toContain('"channel_point_reward_name" = ')
    expect(updates[0].params).toEqual(expect.arrayContaining(['["A","B"]', 'A', MAIN_REWARD_ID, 'Gacha']))
  })

  it('「すべてのカード」に戻すときは旧列 NULL と配列列 [] を同じ UPDATE で書く', async () => {
    const log = installSqlDb((q) => {
      if (!q.sql.startsWith('select')) return []
      if (q.sql.includes('"channel_point_pack_names"')) return [{ channel_point_pack_names: ['A', 'B'] }]
      return [{ ...(settingsSelectRows(q)[0] as object), channel_point_collection_name: 'A' }]
    })

    const res = await settingsPOST(jsonRequest('http://localhost/api/streamer/settings', 'POST', {
      streamerId: STREAMER_ID,
      channelPointCollectionNames: [],
    }))

    expect(res.status).toBe(200)
    const updates = log.filter((q) => isUpdate(q, 'streamers'))
    expect(updates).toHaveLength(1)
    const set = setClause(updates[0])
    expect(set).toMatch(/"channel_point_collection_name" = (null|\$\d+)/)
    expect(set).toContain('"channel_point_pack_names" = ')
    expect(updates[0].params).toContain('[]')
    expect(updates[0].params).not.toContain('A')
  })

  it('パックと無関係の設定保存では配列列を SQL に含めない（migration 未適用のデプロイ窓でも壊れない）', async () => {
    const log = installSqlDb((q) => (q.sql.startsWith('select') ? settingsSelectRows(q) : []))

    const res = await settingsPOST(jsonRequest('http://localhost/api/streamer/settings', 'POST', {
      streamerId: STREAMER_ID,
      chatAnnouncementEnabled: true,
    }))

    expect(res.status).toBe(200)
    expect(log.some((q) => q.sql.includes('channel_point_pack_names'))).toBe(false)
    const updates = log.filter((q) => isUpdate(q, 'streamers'))
    expect(updates).toHaveLength(1)
    expect(setClause(updates[0])).toContain('"chat_announcement_enabled" = ')
  })

  it('配列列が 42703 のときは配列列だけを外し、旧列ミラーと他項目を1本の UPDATE で書き直す', async () => {
    const log = installSqlDb((q) => {
      if (q.sql.startsWith('select')) {
        if (q.sql.includes('"channel_point_pack_names"')) {
          throw missingColumnError('channel_point_pack_names', 'streamers')
        }
        return settingsSelectRows(q)
      }
      if (q.sql.includes('"channel_point_pack_names"')) {
        throw missingColumnError('channel_point_pack_names', 'streamers')
      }
      return []
    })

    const res = await settingsPOST(jsonRequest('http://localhost/api/streamer/settings', 'POST', {
      streamerId: STREAMER_ID,
      channelPointRewardId: MAIN_REWARD_ID,
      channelPointCollectionNames: ['A', 'B'],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const updates = log.filter((q) => isUpdate(q, 'streamers'))
    expect(updates).toHaveLength(2)
    expect(setClause(updates[0])).toContain('"channel_point_pack_names" = ')
    const retrySet = setClause(updates[1])
    expect(retrySet).not.toContain('channel_point_pack_names')
    expect(retrySet).toContain('"channel_point_collection_name" = ')
    expect(retrySet).toContain('"channel_point_reward_id" = ')
    expect(updates[1].params).toEqual(expect.arrayContaining(['A', MAIN_REWARD_ID]))
    // 2要素目以降は旧列に載らないため、黙って成功扱いにせずフラグで知らせる。
    expect(body.channelPointCollectionNamesSkippedDeployWindow).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 必須1/3: POST・PUT /api/streamer/additional-rewards（追加報酬）
// ---------------------------------------------------------------------------

const ADDITIONAL_TABLE = 'streamer_additional_gacha_rewards'

/** additional-rewards ルートの streamers SELECT（所有権 + 登録済みパック）へ返す行。 */
function streamerOwnershipRow() {
  return { id: STREAMER_ID, channel_point_reward_id: MAIN_REWARD_ID, card_pack_names: ['A', 'B', 'C'] }
}

function insertedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    streamer_id: STREAMER_ID,
    reward_id: ADDITIONAL_REWARD_ID,
    reward_name: 'Extra',
    draw_count: 1,
    is_raid_limited: false,
    collection_name: null,
    created_at: '2026-11-08T00:00:00Z',
    ...overrides,
  }
}

describe('POST /api/streamer/additional-rewards: 発行 SQL (Issue #1994 必須1)', () => {
  it('パック指定ありの作成は reward_pack_names と旧列ミラーを同じ INSERT で書く', async () => {
    const log = installSqlDb((q) => {
      if (isSelectFrom(q, 'streamers')) return [streamerOwnershipRow()]
      if (isInsert(q, ADDITIONAL_TABLE)) {
        return [insertedRow({ collection_name: 'A', reward_pack_names: ['A', 'B'] })]
      }
      return []
    })

    const res = await additionalRewardsPOST(jsonRequest('http://localhost/api/streamer/additional-rewards', 'POST', {
      rewardId: ADDITIONAL_REWARD_ID,
      rewardName: 'Extra',
      collectionNames: ['A', 'B'],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const inserts = log.filter((q) => isInsert(q, ADDITIONAL_TABLE))
    expect(inserts).toHaveLength(1)
    const columns = inserts[0].sql.slice(0, inserts[0].sql.indexOf(' values '))
    expect(columns).toContain('"reward_pack_names"')
    expect(columns).toContain('"collection_name"')
    expect(inserts[0].params).toEqual(expect.arrayContaining(['["A","B"]', 'A']))
    // 応答は GET と同じ形（collection_names に解決済み配列、生の reward_pack_names は出さない）。
    expect(body.reward.collection_names).toEqual(['A', 'B'])
    expect(body.reward).not.toHaveProperty('reward_pack_names')
  })

  it('パック指定なしの作成では reward_pack_names を INSERT にも RETURNING にも含めない', async () => {
    const log = installSqlDb((q) => {
      if (isSelectFrom(q, 'streamers')) return [streamerOwnershipRow()]
      if (isInsert(q, ADDITIONAL_TABLE)) return [insertedRow()]
      return []
    })

    const res = await additionalRewardsPOST(jsonRequest('http://localhost/api/streamer/additional-rewards', 'POST', {
      rewardId: ADDITIONAL_REWARD_ID,
      rewardName: 'Extra',
    }))

    expect(res.status).toBe(200)
    const inserts = log.filter((q) => isInsert(q, ADDITIONAL_TABLE))
    expect(inserts).toHaveLength(1)
    expect(inserts[0].sql).not.toContain('reward_pack_names')
  })

  it('reward_pack_names が 42703 のときは新列を外して旧列ミラーだけで INSERT し直す', async () => {
    const log = installSqlDb((q) => {
      if (isSelectFrom(q, 'streamers')) return [streamerOwnershipRow()]
      if (isInsert(q, ADDITIONAL_TABLE)) {
        if (q.sql.includes('reward_pack_names')) throw missingColumnError('reward_pack_names', ADDITIONAL_TABLE)
        return [insertedRow({ collection_name: 'A' })]
      }
      return []
    })

    const res = await additionalRewardsPOST(jsonRequest('http://localhost/api/streamer/additional-rewards', 'POST', {
      rewardId: ADDITIONAL_REWARD_ID,
      rewardName: 'Extra',
      collectionNames: ['A', 'B'],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const inserts = log.filter((q) => isInsert(q, ADDITIONAL_TABLE))
    expect(inserts).toHaveLength(2)
    expect(inserts[1].sql).not.toContain('reward_pack_names')
    expect(inserts[1].sql.slice(0, inserts[1].sql.indexOf(' values '))).toContain('"collection_name"')
    expect(inserts[1].params).toContain('A')
    expect(body.reward.collection_names).toEqual(['A'])
  })
})

/** PUT の SELECT（所有権 / 更新対象の現在値）へ返す行を作る。 */
function putSelectRows(
  current: { collection_name: string | null; reward_pack_names: string[] },
  options: { packNamesMissing?: boolean } = {},
) {
  return (q: RenderedQuery): unknown[] => {
    if (isSelectFrom(q, 'streamers')) return [streamerOwnershipRow()]
    if (isSelectFrom(q, ADDITIONAL_TABLE)) {
      if (q.sql.includes('reward_pack_names')) {
        if (options.packNamesMissing) throw missingColumnError('reward_pack_names', ADDITIONAL_TABLE)
        return [{ id: 'row-1', ...current }]
      }
      return [{ id: 'row-1', collection_name: current.collection_name }]
    }
    return []
  }
}

/** PUT の RETURNING は明示列（streamer_id を含まない）なので、その形の行を返す。 */
function updatedRow(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = insertedRow(overrides)
  delete row.streamer_id
  return row
}

describe('PUT /api/streamer/additional-rewards: 発行 SQL (Issue #1994 必須1/3)', () => {
  it('パック割り当ての変更は reward_pack_names と旧列ミラーを同じ UPDATE で書き、応答は collection_names', async () => {
    const selects = putSelectRows({ collection_name: null, reward_pack_names: [] })
    const log = installSqlDb((q) => {
      if (q.sql.startsWith('select')) return selects(q)
      if (isUpdate(q, ADDITIONAL_TABLE)) {
        return [updatedRow({ collection_name: 'A', reward_pack_names: ['A', 'B'] })]
      }
      return []
    })

    const res = await additionalRewardsPUT(jsonRequest('http://localhost/api/streamer/additional-rewards', 'PUT', {
      rewardId: ADDITIONAL_REWARD_ID,
      collectionNames: ['A', 'B'],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const updates = log.filter((q) => isUpdate(q, ADDITIONAL_TABLE))
    expect(updates).toHaveLength(1)
    const set = setClause(updates[0])
    expect(set).toContain('"reward_pack_names" = ')
    expect(set).toContain('"collection_name" = ')
    expect(updates[0].params).toEqual(expect.arrayContaining(['["A","B"]', 'A']))
    expect(body.reward.collection_names).toEqual(['A', 'B'])
    expect(body.reward).not.toHaveProperty('reward_pack_names')
    expect(body.collectionNameSkippedDeployWindow).toBeUndefined()
  })

  it('CAS は旧列だけでなく配列列の現在値も WHERE で比較する（先頭が同じ [A,B]→[A,C] の競合を検出）', async () => {
    const selects = putSelectRows({ collection_name: 'A', reward_pack_names: ['A', 'B'] })
    const log = installSqlDb((q) => {
      if (q.sql.startsWith('select')) return selects(q)
      if (isUpdate(q, ADDITIONAL_TABLE)) return [updatedRow({ collection_name: 'A', reward_pack_names: ['A', 'C'] })]
      return []
    })

    const res = await additionalRewardsPUT(jsonRequest('http://localhost/api/streamer/additional-rewards', 'PUT', {
      rewardId: ADDITIONAL_REWARD_ID,
      collectionNames: ['A', 'C'],
    }))

    expect(res.status).toBe(200)
    const update = log.filter((q) => isUpdate(q, ADDITIONAL_TABLE))[0]
    const where = update.sql.slice(update.sql.indexOf(' where '), update.sql.indexOf(' returning '))
    expect(where).toContain('"collection_name" = ')
    expect(where).toContain('"reward_pack_names" = ')
    expect(update.params).toEqual(expect.arrayContaining(['["A","C"]', '["A","B"]']))
  })

  it('枚数だけの更新では reward_pack_names を SET に含めない', async () => {
    const selects = putSelectRows({ collection_name: 'A', reward_pack_names: ['A', 'B'] })
    const log = installSqlDb((q) => {
      if (q.sql.startsWith('select')) return selects(q)
      if (isUpdate(q, ADDITIONAL_TABLE)) return [updatedRow({ draw_count: 3, collection_name: 'A', reward_pack_names: ['A', 'B'] })]
      return []
    })

    const res = await additionalRewardsPUT(jsonRequest('http://localhost/api/streamer/additional-rewards', 'PUT', {
      rewardId: ADDITIONAL_REWARD_ID,
      drawCount: 3,
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const updates = log.filter((q) => isUpdate(q, ADDITIONAL_TABLE))
    expect(updates).toHaveLength(1)
    expect(setClause(updates[0])).not.toContain('reward_pack_names')
    expect(body.reward.collection_names).toEqual(['A', 'B'])
  })

  it('必須3: 枚数だけの更新で RETURNING の reward_pack_names が 42703 なら、その列を外した RETURNING で再実行し 200 を返す', async () => {
    const selects = putSelectRows({ collection_name: 'A', reward_pack_names: [] }, { packNamesMissing: true })
    const log = installSqlDb((q) => {
      if (q.sql.startsWith('select')) return selects(q)
      if (isUpdate(q, ADDITIONAL_TABLE)) {
        if (q.sql.includes('reward_pack_names')) throw missingColumnError('reward_pack_names', ADDITIONAL_TABLE)
        return [updatedRow({ draw_count: 3, collection_name: 'A' })]
      }
      return []
    })

    const res = await additionalRewardsPUT(jsonRequest('http://localhost/api/streamer/additional-rewards', 'PUT', {
      rewardId: ADDITIONAL_REWARD_ID,
      drawCount: 3,
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const updates = log.filter((q) => isUpdate(q, ADDITIONAL_TABLE))
    const last = updates[updates.length - 1]
    expect(last.sql).not.toContain('reward_pack_names')
    // 旧列は RETURNING に残し、collection_names を旧列から解決する（minimal へ落とさない）。
    expect(returningClause(last)).toContain('"collection_name"')
    expect(body.reward.collection_names).toEqual(['A'])
    expect(body.reward.draw_count).toBe(3)
    // 枚数だけの更新はパック変更を含まないため「パック反映待ち」と誤表示しない。
    expect(body.collectionNameSkippedDeployWindow).toBeUndefined()
  })

  it('reward_pack_names が 42703 のパック変更は、新列を外して旧列ミラーを書き、複数パックの欠落をフラグで知らせる', async () => {
    const selects = putSelectRows({ collection_name: null, reward_pack_names: [] }, { packNamesMissing: true })
    const log = installSqlDb((q) => {
      if (q.sql.startsWith('select')) return selects(q)
      if (isUpdate(q, ADDITIONAL_TABLE)) {
        if (q.sql.includes('reward_pack_names')) throw missingColumnError('reward_pack_names', ADDITIONAL_TABLE)
        return [updatedRow({ collection_name: 'A' })]
      }
      return []
    })

    const res = await additionalRewardsPUT(jsonRequest('http://localhost/api/streamer/additional-rewards', 'PUT', {
      rewardId: ADDITIONAL_REWARD_ID,
      collectionNames: ['A', 'B'],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const updates = log.filter((q) => isUpdate(q, ADDITIONAL_TABLE))
    const last = updates[updates.length - 1]
    expect(last.sql).not.toContain('reward_pack_names')
    expect(setClause(last)).toContain('"collection_name" = ')
    expect(last.params).toContain('A')
    expect(body.reward.collection_names).toEqual(['A'])
    expect(body.collectionNameSkippedDeployWindow).toBe(true)
  })
})

describe('GET /api/streamer/additional-rewards: reward_pack_names 欠落窓の collection_names', () => {
  it('42703 のときは旧列ありの SELECT へ縮退し、collection_names を [] ではなく旧列から解決する', async () => {
    const log = installSqlDb((q) => {
      if (isSelectFrom(q, 'streamers')) return [{ id: STREAMER_ID }]
      if (isSelectFrom(q, ADDITIONAL_TABLE)) {
        if (q.sql.includes('reward_pack_names')) throw missingColumnError('reward_pack_names', ADDITIONAL_TABLE)
        return [updatedRow({ collection_name: 'A' })]
      }
      return []
    })

    const res = await additionalRewardsGET(new NextRequest('http://localhost/api/streamer/additional-rewards'))
    const body = await res.json()

    expect(res.status).toBe(200)
    const rewardSelects = log.filter((q) => isSelectFrom(q, ADDITIONAL_TABLE))
    expect(rewardSelects).toHaveLength(2)
    expect(rewardSelects[1].sql).not.toContain('reward_pack_names')
    // [] だと UI が「すべてのカード」と表示し、編集保存で旧列のパックまで消える。
    expect(body[0].collection_names).toEqual(['A'])
  })
})

// ---------------------------------------------------------------------------
// 必須2: GET /api/twitch/channel-point-bootstrap?diagnostics=1
// ---------------------------------------------------------------------------

describe('GET /api/twitch/channel-point-bootstrap: 追加報酬の collection_names (Issue #1994 必須2)', () => {
  beforeEach(() => {
    __resetTwitchAppTokenForTests()
    vi.mocked(hasScope).mockResolvedValue(true)
    vi.mocked(getTwitchAccessToken).mockResolvedValue('user-token')
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }))
  })

  const bootstrapRequest = () => new NextRequest('http://localhost/api/twitch/channel-point-bootstrap?diagnostics=1')
  const streamerRow = { id: STREAMER_ID, channel_point_reward_id: MAIN_REWARD_ID, raid_gacha_draw_count: 0 }
  const rewardRow = {
    id: 'row-1',
    reward_id: ADDITIONAL_REWARD_ID,
    reward_name: 'Extra',
    draw_count: 1,
    is_raid_limited: false,
    collection_name: 'A',
    created_at: '2026-11-08T00:00:00Z',
  }

  it('reward_pack_names を読み、GET /api/streamer/additional-rewards と同じ collection_names を返す', async () => {
    const log = installSqlDb((q) => {
      if (isSelectFrom(q, 'streamers')) return [streamerRow]
      if (isSelectFrom(q, ADDITIONAL_TABLE)) return [{ ...rewardRow, reward_pack_names: ['A', 'B'] }]
      return []
    })

    const res = await bootstrapGET(bootstrapRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(log.filter((q) => isSelectFrom(q, ADDITIONAL_TABLE))[0].sql).toContain('"reward_pack_names"')
    expect(body.additionalRewards).toHaveLength(1)
    expect(body.additionalRewards[0].collection_names).toEqual(['A', 'B'])
    expect(body.additionalRewards[0].collection_name).toBe('A')
    expect(body.additionalRewards[0]).not.toHaveProperty('reward_pack_names')
  })

  it('reward_pack_names が 42703 のときは旧列ありの SELECT へ縮退し、collection_names を旧列から解決する', async () => {
    const log = installSqlDb((q) => {
      if (isSelectFrom(q, 'streamers')) return [streamerRow]
      if (isSelectFrom(q, ADDITIONAL_TABLE)) {
        if (q.sql.includes('reward_pack_names')) throw missingColumnError('reward_pack_names', ADDITIONAL_TABLE)
        return [rewardRow]
      }
      return []
    })

    const res = await bootstrapGET(bootstrapRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    const rewardSelects = log.filter((q) => isSelectFrom(q, ADDITIONAL_TABLE))
    expect(rewardSelects).toHaveLength(2)
    expect(rewardSelects[1].sql).not.toContain('reward_pack_names')
    expect(rewardSelects[1].sql).toContain('"collection_name"')
    expect(body.additionalRewards[0].collection_names).toEqual(['A'])
  })
})

// ---------------------------------------------------------------------------
// Issue #2005 (任意2): 「先に報告された列を剥がした後、もう1列も 42703」になる
// 2段フォールバック。PostgreSQL は1回の失敗で欠落列を1つしか報告しないため、
// 配列列と旧単一列が同時に未適用の窓ではフォールバックを2回たどる必要がある。
// ---------------------------------------------------------------------------

describe('POST /api/streamer/settings: 2段フォールバック (Issue #2005 任意2)', () => {
  it('channel_point_pack_names と channel_point_collection_name が連続して 42703 でも、報告順に2列とも剥がして書き切る', async () => {
    const log = installSqlDb((q) => {
      if (q.sql.startsWith('select')) {
        // 列が実在しない窓では現在値の SELECT 自体も 42703 になる
        // （ルート側は isMissingChannelPointPackNamesColumnError で縮退する）。
        if (q.sql.includes('"channel_point_pack_names"')) {
          throw missingColumnError('channel_point_pack_names', 'streamers')
        }
        return settingsSelectRows(q)
      }
      // 欠落列は1回の失敗で1つしか報告されないため、配列列を剥がした再試行で
      // 初めて旧列の欠落が報告される順序を再現する。
      if (q.sql.includes('"channel_point_pack_names"')) {
        throw missingColumnError('channel_point_pack_names', 'streamers')
      }
      if (q.sql.includes('"channel_point_collection_name"')) {
        throw missingColumnError('channel_point_collection_name', 'streamers')
      }
      return []
    })

    const res = await settingsPOST(jsonRequest('http://localhost/api/streamer/settings', 'POST', {
      streamerId: STREAMER_ID,
      channelPointRewardId: MAIN_REWARD_ID,
      channelPointCollectionNames: ['A', 'B'],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const updates = log.filter((q) => isUpdate(q, 'streamers'))
    expect(updates).toHaveLength(3)
    expect(setClause(updates[0])).toContain('"channel_point_pack_names" = ')
    const secondSet = setClause(updates[1])
    expect(secondSet).not.toContain('channel_point_pack_names')
    expect(secondSet).toContain('"channel_point_collection_name" = ')
    const lastSet = setClause(updates[2])
    expect(lastSet).not.toContain('channel_point_pack_names')
    expect(lastSet).not.toContain('channel_point_collection_name')
    // パック列を全部剥がしても、同時に送った他項目は最後の UPDATE に残る。
    expect(lastSet).toContain('"channel_point_reward_id" = ')
    expect(updates[2].params).toContain(MAIN_REWARD_ID)
    // 2要素以上の割り当ては旧列（先頭要素）だけでも表せず、今回は旧列すら
    // 書けなかったため、欠損をフラグで知らせる（黙って成功扱いにしない）。
    expect(body.channelPointCollectionNamesSkippedDeployWindow).toBe(true)
  })
})

describe('POST /api/streamer/additional-rewards: 2段フォールバック (Issue #2005 任意2)', () => {
  it('reward_pack_names と collection_name が連続して 42703 でも、報告順に2列とも剥がして INSERT し直す', async () => {
    const log = installSqlDb((q) => {
      if (isSelectFrom(q, 'streamers')) return [streamerOwnershipRow()]
      if (isInsert(q, ADDITIONAL_TABLE)) {
        // 欠落判定は INSERT の列リストだけで見る（引数なし returning() が定義の
        // 全列を描画するため、SQL 全体で探すと RETURNING 側に残る列名に誤爆する）。
        const columns = q.sql.slice(0, q.sql.indexOf(' values '))
        if (columns.includes('reward_pack_names')) throw missingColumnError('reward_pack_names', ADDITIONAL_TABLE)
        if (columns.includes('"collection_name"')) throw missingColumnError('collection_name', ADDITIONAL_TABLE)
        return [insertedRow()]
      }
      return []
    })

    const res = await additionalRewardsPOST(jsonRequest('http://localhost/api/streamer/additional-rewards', 'POST', {
      rewardId: ADDITIONAL_REWARD_ID,
      rewardName: 'Extra',
      collectionNames: ['A', 'B'],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const inserts = log.filter((q) => isInsert(q, ADDITIONAL_TABLE))
    expect(inserts).toHaveLength(3)
    const secondColumns = inserts[1].sql.slice(0, inserts[1].sql.indexOf(' values '))
    expect(secondColumns).not.toContain('reward_pack_names')
    expect(secondColumns).toContain('"collection_name"')
    const lastColumns = inserts[2].sql.slice(0, inserts[2].sql.indexOf(' values '))
    expect(lastColumns).not.toContain('reward_pack_names')
    expect(lastColumns).not.toContain('collection_name')
    // パック割り当ては一切書けなかったため、欠損をフラグで知らせる。
    expect(body.collectionNameSkippedDeployWindow).toBe(true)
  })

  it('逆順（collection_name → reward_pack_names の順に 42703）でも、報告順に2列とも剥がして INSERT し直す', async () => {
    const log = installSqlDb((q) => {
      if (isSelectFrom(q, 'streamers')) return [streamerOwnershipRow()]
      if (isInsert(q, ADDITIONAL_TABLE)) {
        const columns = q.sql.slice(0, q.sql.indexOf(' values '))
        // collection_name の欠落が先に報告される順序。剥がした後の再試行で
        // reward_pack_names が報告され、最終的に両方を含まない INSERT になる。
        if (columns.includes('"collection_name"')) throw missingColumnError('collection_name', ADDITIONAL_TABLE)
        if (columns.includes('reward_pack_names')) throw missingColumnError('reward_pack_names', ADDITIONAL_TABLE)
        return [insertedRow()]
      }
      return []
    })

    const res = await additionalRewardsPOST(jsonRequest('http://localhost/api/streamer/additional-rewards', 'POST', {
      rewardId: ADDITIONAL_REWARD_ID,
      rewardName: 'Extra',
      collectionNames: ['A', 'B'],
    }))
    const body = await res.json()

    expect(res.status).toBe(200)
    const inserts = log.filter((q) => isInsert(q, ADDITIONAL_TABLE))
    expect(inserts).toHaveLength(3)
    const secondColumns = inserts[1].sql.slice(0, inserts[1].sql.indexOf(' values '))
    expect(secondColumns).not.toContain('collection_name')
    expect(secondColumns).toContain('"reward_pack_names"')
    const lastColumns = inserts[2].sql.slice(0, inserts[2].sql.indexOf(' values '))
    expect(lastColumns).not.toContain('reward_pack_names')
    expect(lastColumns).not.toContain('collection_name')
    expect(body.collectionNameSkippedDeployWindow).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Issue #2005 (任意3): checkCollectionsHaveActiveCards（複数パックのバッチ存在
// 検査）が実際に発行する SQL を恒久テストにする。これまでは丸ごとモックか
// SQL を見ずに行を返すモックしかなかった。固定する内容（レビュアーの描画確認
// と同じ）: `select "collection_name" from "cards" where (streamer_id = $1 and
// is_active = $2 and (collection_name in ($3,$4) or collection_name is null))
// group by collection_name` — パック名は全てパラメータで、__default__ は
// GROUP BY の NULL 行として存在判定される。
// ---------------------------------------------------------------------------

describe('checkCollectionsHaveActiveCards: 発行 SQL (Issue #2005 任意3)', () => {
  it('複数パックは1本の GROUP BY クエリで検査し、パック名は全てパラメータ、__default__ は NULL 行で判定する', async () => {
    const { checkCollectionsHaveActiveCards: realCheck } =
      await vi.importActual<typeof import('@/lib/collections/collection-existence')>(
        '@/lib/collections/collection-existence'
      )
    const log = installSqlDb(() => [
      { collection_name: 'weapons' },
      // __default__（未分類パック）に対応する GROUP BY の NULL 行。
      { collection_name: null },
    ])

    const result = await realCheck(STREAMER_ID, ['weapons', 'characters', DEFAULT_PACK_SENTINEL])

    const selects = log.filter((q) => isSelectFrom(q, 'cards'))
    expect(selects).toHaveLength(1)
    const query = selects[0]
    expect(query.sql).toMatch(/^select "collection_name" from "cards"/)
    expect(query.sql).toContain('group by')
    // パック名は SQL 文へ直接埋め込まれず、全てバインドパラメータになる
    // （streamer_id と is_active を含む WHERE 全体でプレースホルダのみ）。
    expect(query.params).toEqual([STREAMER_ID, true, 'weapons', 'characters'])
    expect(query.sql).not.toContain('weapons')
    expect(query.sql).not.toContain('characters')
    // __default__ は IN リストの文字列としてではなく IS NULL 条件に展開される
    // （センチネルをパラメータにも含めない）。
    expect(query.params).not.toContain(DEFAULT_PACK_SENTINEL)
    expect(query.sql).toContain(' is null')
    expect(query.sql).not.toContain('__default__')
    // 行が返ったパックのみ exists。NULL 行は __default__ の存在として判定される。
    expect(result.get('weapons')).toBe('exists')
    expect(result.get('characters')).toBe('absent')
    expect(result.get(DEFAULT_PACK_SENTINEL)).toBe('exists')
  })

  it('GROUP BY の結果に NULL 行が無ければ __default__ は absent と判定する', async () => {
    const { checkCollectionsHaveActiveCards: realCheck } =
      await vi.importActual<typeof import('@/lib/collections/collection-existence')>(
        '@/lib/collections/collection-existence'
      )
    installSqlDb(() => [{ collection_name: 'weapons' }])

    const result = await realCheck(STREAMER_ID, ['weapons', DEFAULT_PACK_SENTINEL])

    expect(result.get('weapons')).toBe('exists')
    expect(result.get(DEFAULT_PACK_SENTINEL)).toBe('absent')
  })
})
