import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(process.cwd(), 'db/planetscale/migrations/20261031120000_chat_outbox_payload_version_2.sql'),
  'utf8',
)

describe('chat outbox payload_version=2 migration (Issue #1548)', () => {
  // v1/v2 の配送側分岐は decoder・engine の unit test が固定し、実INSERT値は
  // PostgreSQL fixture suite が担保する。このファイルはSQL実装断片だけを固定する。
  it('payload_version の CHECK を {1,2} へ緩和する（DEFAULT=1は据え置き）', () => {
    expect(migration).toContain('DROP CONSTRAINT chat_notification_outbox_payload_version_check')
    expect(migration).toContain('ADD CONSTRAINT chat_notification_outbox_payload_version_check')
    expect(migration).toContain('CHECK (payload_version IN (1, 2))')
    // 書き込み側は常にversionを明示する契約のため、DEFAULT=1の変更は行わない。
    expect(migration).not.toContain('SET DEFAULT 2')
  })

  it('同じRPCを置換し、新規outbox行へpayload_version=2を書き込む', () => {
    expect(migration).toMatch(/^--\s*migration-transaction\s*:\s*required\s*\r?\n--\s*migration-providers\s*:\s*planetscale/m)
    expect(migration).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.execute_gacha_transaction_with_chat_outbox\s*\(/)
    expect(migration).toMatch(/INSERT\s+INTO\s+public\.chat_notification_outbox\s*\(\s*batch_id\s*,\s*payload_version\s*,\s*payload\s*,\s*expected_draw_count/)
    expect(migration).toMatch(/SELECT\s+p_chat_batch_id\s*,\s*2\s*,\s*jsonb_build_object\s*\(/)
  })

  it('v1行のstreamerスナップショット形状を維持する（flag列をpayloadへ残す）', () => {
    // v2でもpayload shapeは変えない。decoderが新旧両versionで同じ必須fieldを
    // 検証するため、streamerスナップショットから列を外すと全行がDLQ化する。
    expect(migration).toContain("'chat_announcement_multi_show_cards', s.chat_announcement_multi_show_cards")
    expect(migration).toContain("'chat_announcement_multi_template', s.chat_announcement_multi_template")
  })
})
