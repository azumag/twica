import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'db/planetscale/migrations/20261007120000_streamer_stats_aggregation.sql'),
  'utf8',
)

// Issue #741: PlanetScale migration contract tests.
// SQL の実行意味 (冪等性・JST 境界・ゲート) は実 PostgreSQL 17 への適用で
// 検証済み (PR 参照)。ここでは現行 runtime 契約の構造面を固定する。
describe('streamer stats aggregation migration', () => {
  it('PlanetScale transaction migrationとして宣言する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/)
  })

  it('PlanetScale移行後の方針どおりRLSやSECURITY DEFINERに依存しない', () => {
    // add-card-trading-migration.test.ts と同一規約: コメント行を除いた
    // 実コード側にのみ現れないことを検証する。
    const codeOnly = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')

    expect(codeOnly).not.toContain('ENABLE ROW LEVEL SECURITY')
    expect(codeOnly).not.toContain('SECURITY DEFINER')
  })

  it('3テーブルを主キー・CHECK・必要index付きで作る', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.streamer_daily_stats')
    expect(migration).toContain('PRIMARY KEY (streamer_id, stat_date)')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.streamer_ranking_snapshots')
    expect(migration).toContain('PRIMARY KEY (metric, period, streamer_id)')
    expect(migration).toContain("CHECK (metric IN ('draws', 'card_count'))")
    expect(migration).toContain("CHECK (period IN ('daily', 'weekly', 'total', 'current'))")
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.stats_meta')
    expect(migration).toContain('idx_streamer_daily_stats_date')
    expect(migration).toContain('idx_ranking_snapshots_position')
  })

  it('gacha_history の redeemed_at 先頭indexを追加する', () => {
    expect(migration).toContain('idx_gacha_history_redeemed_at')
    expect(migration).toContain('ON public.gacha_history(redeemed_at)')
  })

  it('新オブジェクトをruntimeロールだけに公開する', () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.streamer_daily_stats FROM PUBLIC, anon, authenticated',
    )
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_daily_stats TO service_role',
    )
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.streamer_ranking_snapshots FROM PUBLIC, anon, authenticated',
    )
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.stats_meta FROM PUBLIC, anon, authenticated',
    )
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.refresh_streamer_daily_stats(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated',
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.refresh_streamer_ranking() TO service_role',
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.backfill_streamer_daily_stats() TO service_role',
    )
  })

  it('JST日境界へ範囲を拡張して冪等に再計算する', () => {
    // 引数の瞬時をJST日付へ丸め、スキャン範囲を丸一日単位へ拡張する。
    expect(migration).toContain("(p_from AT TIME ZONE 'Asia/Tokyo')::date")
    expect(migration).toContain("(p_to AT TIME ZONE 'Asia/Tokyo')::date")
    expect(migration).toContain('d_from AT TIME ZONE')
    expect(migration).toContain('(d_to + 1) AT TIME ZONE')
    expect(migration).toContain('ON CONFLICT (streamer_id, stat_date) DO UPDATE')
    // 範囲内で排出0件になった既存行はDELETEする (イベント巻き戻し対応)。
    expect(migration).toContain('DELETE FROM public.streamer_daily_stats')
    expect(migration).toContain('NOT EXISTS')
  })

  it('手動ドローをdraws集計から除外する (Issue #784 の不変条件)', () => {
    const occurrences = migration.split("event_id NOT LIKE 'manual:%'").length - 1
    // refresh_streamer_daily_stats と backfill_streamer_daily_stats の2箇所。
    expect(occurrences).toBe(2)
  })

  it('ranking再計算にadvisory lockとcooldownの多重実行防止を持つ', () => {
    expect(migration).toContain("pg_try_advisory_xact_lock(hashtext('twica:stats:refresh'))")
    expect(migration).toContain('lock-contention')
    expect(migration).toContain("interval '10 minutes'")
    expect(migration).toContain('cooldown')
  })

  it('backfillマーカー未設定の間スナップショットを一切生成しない', () => {
    expect(migration).toContain('daily_stats_backfilled_at')
    expect(migration).toContain('backfill-pending')
    // マーカー確認は日次増分の後・DELETE→INSERT の前。
    const markerCheck = migration.indexOf('daily_stats_backfilled_at')
    const snapshotDelete = migration.indexOf('DELETE FROM public.streamer_ranking_snapshots')
    expect(markerCheck).toBeGreaterThan(0)
    expect(snapshotDelete).toBeGreaterThan(markerCheck)
  })

  it('4種のメトリクスを同一computed_atで原子的置換する', () => {
    expect(migration).toContain("'draws'::text AS metric, 'total'::text AS period")
    expect(migration).toContain("'draws', 'weekly'")
    expect(migration).toContain("'draws', 'daily'")
    expect(migration).toContain("'card_count', 'current'")
    expect(migration).toContain('RANK()')
    expect(migration).toContain('ROW_NUMBER()')
    // 同一バッチの全行で同一値。
    expect(migration).toContain('v_now')
  })

  it('backfillはmigration内で実行せず完了マーカーだけを定義する', () => {
    expect(migration).toContain('backfill_streamer_daily_stats')
    expect(migration).toContain("VALUES ('daily_stats_backfilled_at'")
    // 自動適用ブロックの原因になる文を含まない (SET LOCAL / TRUNCATE)。
    const codeOnly = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    expect(codeOnly).not.toMatch(/\bSET\s+LOCAL\b/i)
    expect(codeOnly).not.toMatch(/\bTRUNCATE\b/i)
  })
})
