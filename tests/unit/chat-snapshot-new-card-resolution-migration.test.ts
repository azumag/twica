import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'db/planetscale/migrations/20260803090000_chat_snapshot_new_card_resolution.sql'),
  'utf8',
)

describe('chat snapshot new-card resolution migration', () => {
  // v1 JSONのdecoder互換と実際のpayload値は、それぞれdecoder unitとPostgreSQL fixtureで
  // 検証する。このファイルはSQL実装断片だけを固定し、コメント文言への依存を避ける。
  it('既適用のv1 outbox schemaを変えず、同じRPCを置換する', () => {
    expect(migration).toMatch(/^--\s*migration-transaction\s*:\s*required\s*\r?\n--\s*migration-providers\s*:\s*planetscale/m)
    expect(migration).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.execute_gacha_transaction_with_chat_outbox\s*\(/)
    expect(migration).not.toMatch(/CREATE\s+TABLE\s+public\.chat_notification_outbox/)
    expect(migration).not.toMatch(/ALTER\s+TABLE\s+public\.chat_notification_outbox/)
    expect(migration).toMatch(/INSERT\s+INTO\s+public\.chat_notification_outbox\s*\(\s*batch_id\s*,\s*payload_version\s*,\s*payload\s*,\s*expected_draw_count/)
    expect(migration).toMatch(/SELECT\s+p_chat_batch_id\s*,\s*1\s*,\s*jsonb_build_object\s*\(/)
  })

  it('最終所持数とevent時刻ごとの付与数が両方確認できたときだけ解決済みを加算する', () => {
    expect(migration).toMatch(/v_new_card_names_resolved\s+boolean/)
    expect(migration).toMatch(/drawn_card_counts\s+AS\s*\([\s\S]*?FROM\s+expected_events\s+JOIN\s+gacha_history\s+gh\s+ON\s+gh\.event_id\s*=\s*expected_events\.event_id[\s\S]*?WHERE\s+gh\.streamer_id\s*=\s*p_streamer_id\s+AND\s+gh\.user_twitch_id\s*=\s*p_user_twitch_id[\s\S]*?GROUP\s+BY\s+gh\.card_id\s*\)/)
    expect(migration).toMatch(/FROM\s+drawn_card_counts\s+drawn\s+LEFT\s+JOIN\s+user_card_counts\s+owned\s+ON\s+owned\.card_id\s*=\s*drawn\.card_id/)
    expect(migration).toMatch(/WHERE\s+owned\.card_id\s+IS\s+NULL\s+OR\s+owned\.final_count\s*<\s*drawn\.drawn_count/)
    expect(migration).toMatch(/expected_history_timestamp_counts\s+AS\s*\(/)
    expect(migration).toMatch(/expected_history_timestamp_counts\s+AS\s*\([\s\S]*?FROM\s+expected_events\s+JOIN\s+gacha_history\s+gh\s+ON\s+gh\.event_id\s*=\s*expected_events\.event_id\s+WHERE\s+gh\.streamer_id\s*=\s*p_streamer_id\s+AND\s+gh\.user_twitch_id\s*=\s*p_user_twitch_id[\s\S]*?GROUP\s+BY\s+gh\.card_id\s*,\s*gh\.redeemed_at\s*\)/)
    expect(migration).toMatch(/obtained_card_timestamp_counts\s+AS\s*\(/)
    expect(migration).toMatch(/GROUP\s+BY\s+gh\.card_id\s*,\s*gh\.redeemed_at/)
    expect(migration).toMatch(/GROUP\s+BY\s+uc\.card_id\s*,\s*uc\.obtained_at/)
    expect(migration).toMatch(/confirmed\.obtained_at\s*=\s*expected\.redeemed_at/)
    expect(migration).toMatch(/expected\.redeemed_at\s+IS\s+NULL/)
    expect(migration).toMatch(/confirmed\.obtained_count\s*<\s*expected\.expected_count/)
    expect(migration).toMatch(/'newCardNames'\s*,\s*v_new_card_names/)
    expect(migration).toMatch(/'newCardNamesResolved'\s*,\s*v_new_card_names_resolved/)
  })
})
