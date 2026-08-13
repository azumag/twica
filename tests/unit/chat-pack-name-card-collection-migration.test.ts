import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'db/planetscale/migrations/20260813120000_chat_pack_name_card_collection.sql'),
  'utf8',
)

describe('chat pack name card collection migration (#948)', () => {
  it('PlanetScale transaction migrationとして宣言し、既存RPCをCREATE OR REPLACEで差し替える', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/)
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.execute_gacha_transaction_with_chat_outbox(',
    )
    // 旧7引数RPCを曖昧化しない（既存のversioned 11引数シグネチャを維持）
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.execute_gacha_transaction(')
    expect(migration).toContain('p_collection_name text')
  })

  it('カードpayloadにcollection_nameを追加する', () => {
    const cardPayload = migration.slice(
      migration.indexOf("jsonb_build_object(\n          'id', c.id,"),
      migration.indexOf(') AS card_payload'),
    )
    expect(cardPayload).toContain("'max_issuance_count', c.max_issuance_count")
    expect(cardPayload).toContain("'collection_name', c.collection_name")
  })

  it('既存のoutbox payloadフィールド（streamer/gachaResult/chatSnapshot）を維持する', () => {
    for (const fragment of [
      "'chatSnapshot', jsonb_build_object(",
      "'newCardNames', v_new_card_names",
      "'default_card_pack_name', s.default_card_pack_name",
      "'collectionName', p_collection_name",
      'ON CONFLICT (batch_id) DO NOTHING',
    ]) {
      expect(migration).toContain(fragment)
    }
  })

  it('同じシグネチャの差し替えであることをCOMMENTで明示する', () => {
    expect(migration).toContain(
      "COMMENT ON FUNCTION public.execute_gacha_transaction_with_chat_outbox(\n  text, text, text, uuid, uuid, integer, text, text, integer, integer, text\n)",
    )
    expect(migration).toContain('Issue #948')
  })
})
