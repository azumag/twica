import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 視聴者による履歴削除で event_id の冪等性が失われ、再送・replay でカードが
// 再発行される問題の修正。SQL の実行時の挙動は
// tests/integration/gacha-history-tombstone-pg.test.ts が実 PostgreSQL で検証する。
// ここでは、実DBなしで壊れやすい契約（宣言・既存 RPC の維持・権限）を固定する。
const migration = readFileSync(
  join(process.cwd(), 'db/planetscale/migrations/20261027000000_gacha_history_event_tombstones.sql'),
  'utf8',
)
const previousRpc = readFileSync(
  join(process.cwd(), 'db/planetscale/migrations/20260813120000_chat_pack_name_card_collection.sql'),
  'utf8',
)

function rpcBody(source: string): string {
  const start = source.indexOf('CREATE OR REPLACE FUNCTION public.execute_gacha_transaction_with_chat_outbox(')
  return source.slice(start, source.indexOf('$$;', start))
}

describe('gacha history event tombstones migration', () => {
  it('PlanetScale transaction migrationとして宣言し、同じversioned RPCを差し替える', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/)
    expect(migration).toContain('p_collection_name text\n) RETURNS jsonb')
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.execute_gacha_transaction(')
  })

  it('削除時のtriggerで墓石を残し、CASCADEでは残さない', () => {
    expect(migration).toContain('AFTER DELETE ON public.gacha_history')
    expect(migration).toContain('IF NOT EXISTS (SELECT 1 FROM cards WHERE id = OLD.card_id)')
    expect(migration).toContain('ON CONFLICT (event_id) DO NOTHING;\n\n  RETURN NULL;')
    expect(migration).toMatch(/card_id uuid NOT NULL REFERENCES public\.cards\(id\) ON DELETE CASCADE/)
    expect(migration).toMatch(/streamer_id uuid NOT NULL REFERENCES public\.streamers\(id\) ON DELETE CASCADE/)
    // #614: cards / streamers 参照FKは無索引だとCASCADEが全件スキャンになる。
    expect(migration).toContain('ON public.gacha_history_event_tombstones (card_id);')
    expect(migration).toContain('ON public.gacha_history_event_tombstones (streamer_id);')
  })

  it('duplicate判定とbatch再構成の3か所だけが墓石を参照し、それ以外は前のRPCと同じ', () => {
    const current = rpcBody(migration)
    expect(current).toContain('FROM gacha_history_event_tombstones\n      WHERE event_id = p_event_id')
    expect(current.match(/^\s+UNION ALL$/gm)).toHaveLength(3)

    // 墓石対応の追加部分を取り除けば、前の定義と一致する。
    const withoutTombstones = current
      .replace(/\n\n  -- 視聴者が履歴を削除しても[\s\S]*?END IF;\n/, '\n')
      .replace(/JOIN \(\n[\s\S]*?\) gh /g, 'JOIN gacha_history gh ')
    expect(withoutTombstones).toBe(rpcBody(previousRpc))
  })

  it('新規オブジェクトの権限を明示的に付与・剥奪する', () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.gacha_history_event_tombstones FROM PUBLIC, anon, authenticated;',
    )
    expect(migration).toContain(
      'GRANT SELECT, INSERT, DELETE ON TABLE public.gacha_history_event_tombstones TO service_role;',
    )
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.record_gacha_history_event_tombstone()')
  })
})
