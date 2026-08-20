import { describe, expect, it, vi } from 'vitest'

import {
  buildFixtureIdentifiers,
  verifyRollbackTraceless,
} from '../../scripts/db-cutover/layer-canary.mjs'

const RUN_ID = '00000000-0000-4000-8000-000000000001'

describe('db cutover layer canary fixture identifiers', () => {
  it('配信者と通常視聴者を別のTwitch ID形式で識別する', () => {
    expect(buildFixtureIdentifiers(RUN_ID)).toEqual({
      runId: RUN_ID,
      streamerTwitchUserId: `cutover-canary-${RUN_ID}`,
      userTwitchUserId: `cutover-canary-viewer-${RUN_ID}`,
      eventId: `cutover-canary:${RUN_ID}`,
    })
  })

  it('users残存時の復旧文言が実際のviewer専用識別子を案内する', async () => {
    // verifyRollbackTracelessはstreamers/users/history/cardsの順で4つのSELECTを行う。
    // usersだけを残存扱いにして、findingが実際にINSERTしたviewer ID形式を案内する
    // ことを固定する。誤った配信者IDでDELETEするとusers行だけ残るため運用上必須。
    const sqlMock = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'fixture-user' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    const sql = sqlMock as unknown as Parameters<typeof verifyRollbackTraceless>[0]

    const findings = await verifyRollbackTraceless(sql, {
      ...buildFixtureIdentifiers(RUN_ID),
      cardId: null,
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'fail',
      code: 'CANARY_ROLLBACK_TRACE_USERS',
      side: 'target',
    })
    expect(findings[0].message).toContain(
      `twitch_user_id=cutover-canary-viewer-${RUN_ID}`,
    )
    expect(findings[0].message).not.toContain('cutover-canary-<uuid>')
  })
})
