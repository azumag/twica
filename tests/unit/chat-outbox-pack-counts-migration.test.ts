import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(process.cwd(), 'db/planetscale/migrations/20261115120000_chat_outbox_pack_counts.sql'),
  'utf8',
)

describe('chat outbox packCounts migration (Issue #2045)', () => {
  // trigger の保存・未使用時スキップ・is_active 境界などの実挙動は
  // tests/fixtures/chat-outbox-pack-counts-postgres.sql が実PG17で固定する。
  // このファイルは配備互換性とSQL実装断片だけを固定する。
  it('migration descriptor と transaction 方針を持つ', () => {
    expect(migration).toMatch(/^--\s*migration-transaction\s*:\s*required\s*\r?\n--\s*migration-providers\s*:\s*planetscale/m)
  })

  it('chat_notification_outbox へ BEFORE INSERT trigger を追加する', () => {
    expect(migration).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.snapshot_chat_outbox_pack_counts\s*\(\s*\)\s*\r?\nRETURNS\s+trigger/i)
    expect(migration).toContain('zz_snapshot_chat_outbox_pack_counts')
    expect(migration).toMatch(/CREATE\s+TRIGGER\s+zz_snapshot_chat_outbox_pack_counts\s*\r?\n\s+BEFORE\s+INSERT\s+ON\s+public\.chat_notification_outbox/i)
  })

  it('execute_gacha_transaction_with_chat_outbox 本体は置換しない', () => {
    // Issue #2045の互換性要件: RPCを置き換えると古いappからの呼び出し契約を
    // 壊すため、payload拡張はBEFORE INSERT triggerでのみ行う。
    expect(migration).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.execute_gacha_transaction_with_chat_outbox/)
  })

  it('単発・N連スナップショットテンプレートの両方でpackプレースホルダー使用を判定する', () => {
    expect(migration).toContain("{streamer,chat_announcement_template}")
    expect(migration).toContain("{streamer,chat_announcement_multi_template}")
    expect(migration).toContain('{packUnique}')
    expect(migration).toContain('{packAll}')
    // 未使用時は集計を行わず早期returnする（利用しない配信者のコストを増やさない）
    expect(migration).toContain('RETURN NEW')
  })

  it('packKeyの規則とis_active境界をpayload.chatSnapshot.packCountsへ書き込む', () => {
    // 未分類カードはアプリ側 resolveCardPackKey と同じ __default__ sentinel。
    expect(migration).toContain("'__default__'")
    // unique/all ともに有効カードのみを数える
    expect(migration.match(/is_active\s*=\s*true/g)?.length).toBeGreaterThanOrEqual(2)
    // unique は同一カード重複所持を種類数として1に丸める
    expect(migration).toContain('count(DISTINCT uc.card_id)')
    expect(migration).toContain("'{chatSnapshot,packCounts}'")
  })

  it('trigger関数はservice_roleのみ実行可能にする', () => {
    expect(migration).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.snapshot_chat_outbox_pack_counts\s*\(\s*\)\s*\r?\n?\s*FROM\s+PUBLIC,\s*anon,\s*authenticated/)
    expect(migration).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.snapshot_chat_outbox_pack_counts\s*\(\s*\)\s*\r?\n?\s*TO\s+service_role/)
  })
})
