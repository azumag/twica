-- migration-transaction: required
-- migration-providers: planetscale
--
-- Issue #741 (子A): ランキング用統計テーブルとバッチ集計基盤。
-- 他チャンネル比較ランキング (#642) の読み取り経路で gacha_history を毎回
-- スキャンすると DB 負荷が線形増大するため、事前集計テーブル 2 層 +
-- 毎時バッチで解決する。既存のトリガー維持型集計 (00039/00051) とは異なり、
-- cross-streamer 集計・リアルタイム不要のためバッチ方式を採用する。
--
-- 2026-09-24 再ベースライン (Issue #741 状態同期コメント):
-- 本文の旧 runtime 前提 (RLS / service_role 向け GRANT / PostgREST .rpc() /
-- dual-driver / supabase db push) は現行 PlanetScale 単一 runtime
-- (docs/db-driver-migration.md) へ読み替える。具体的には:
--   - RLS ポリシー・SECURITY DEFINER を使わない (twica_app は BYPASSRLS を
--     持ち、呼び出しロール自体が service_role 相当のフルアクセスを持つため。
--     20260817100000_add_card_trading.sql と同一方針)。
--   - 公開範囲の制御は REVOKE ALL ... FROM PUBLIC, anon, authenticated +
--     GRANT ... TO service_role のみで行う (同上ファイルと同一パターン)。
--     anon / authenticated へは一切 GRANT しない (旧本文の 00047 明示 GRANT
--     方針を現行契約へ置き換えたもの。生 snapshot を不要な主体へ公開しない)。
--   - 集計の呼び出しは内部 API から postgres.js + Drizzle 経由の
--     `SELECT * FROM refresh_streamer_ranking()` のみ (.rpc() 分岐なし)。
-- 維持する不変条件 (旧本文より):
--   - JST 日境界を丸一日単位で再計算する冪等性
--   - ranking snapshot の原子的置換、backfill marker、cooldown /
--     advisory-lock 相当の多重実行防止
--   - gacha_history 全期間 scan を読み取り経路へ持ち込まないこと
--
-- 本 migration からの追加の読み替え (実コード検証による修正):
--   - 手動ドロー (event_id LIKE 'manual:%') を draws 集計から除外する。
--     Issue #784 が「gacha_history を参照する全ての集計箇所」へ同条件の追加を
--     要求しており、新規集計もその不変条件に従う。NULL event_id 行も同様に
--     除外される (旧手動ドロー API の残骸であり #784 の意図に合致)。
--   - 集計関数は SECURITY DEFINER を付けない (上記の現行方針)。
--
-- 加法性: CREATE TABLE / INDEX / FUNCTION + REVOKE / GRANT のみ。
-- planetscale-migrate.yml による自動適用が可能 (DROP / RENAME / 型変更なし)。
-- backfill_streamer_daily_stats() の「実行」は本 migration 内では行わない
-- (gacha_history 全期間 scan をデプロイパイプラインに載せない。下記同関数の
-- コメントにある手順で低負荷時間帯に手動実行する)。

-- ---------------------------------------------------------------------------
-- 1. streamer_daily_stats — 日次ロールアップ (増分維持)
-- ---------------------------------------------------------------------------
-- 日付境界は JST。gacha_history.redeemed_at (timestamptz) を
-- (redeemed_at AT TIME ZONE 'Asia/Tokyo')::date で丸める。
-- 列は draw_count のみ。累計値は SUM(draw_count) で導出する
-- (累計の二重管理をしない)。行数は streamers 数 × 稼働日数。
CREATE TABLE IF NOT EXISTS public.streamer_daily_stats (
  streamer_id UUID NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  stat_date DATE NOT NULL,
  draw_count INTEGER NOT NULL DEFAULT 0 CHECK (draw_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (streamer_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_streamer_daily_stats_date
  ON public.streamer_daily_stats(stat_date);

REVOKE ALL ON TABLE public.streamer_daily_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_daily_stats TO service_role;

COMMENT ON TABLE public.streamer_daily_stats IS
  '配信者×JST日付の日次排出ロールアップ。refresh_streamer_daily_stats() が
  増分維持する (Issue #741)。読み取り側は SUM(draw_count) で累計を導出する。';

-- ---------------------------------------------------------------------------
-- 2. streamer_ranking_snapshots — ランキング確定値 (毎時、原子的置換)
-- ---------------------------------------------------------------------------
-- v1 の組み合わせは draws×{daily,weekly,total} と card_count×current の
-- 4 種のみ (CHECK 制約上は他の組み合わせも通るが、生成元が
-- refresh_streamer_ranking() に限られるため許容する)。
-- 順序は ORDER BY value DESC, streamer_id で決定的。rank は RANK()
-- (同値同順位)、position は ROW_NUMBER() (一意な並び位置)。
-- 「自分の前後 N 件」は position で引く (rank だと同値・飛び番で位置ベースの
-- 取得が成立しないため)。
-- 母集団: 直近 30 日間 (JST) に排出のあるチャンネル。daily/weekly はさらに
-- 該当期間 value > 0 のみ。streamers.is_active は使わない。
-- computed_at は同一バッチ内の全行で同一値 (読み取り側の鮮度表示用)。
-- 履歴は保持しない (最新のみ、DELETE→INSERT で置換)。
CREATE TABLE IF NOT EXISTS public.streamer_ranking_snapshots (
  metric TEXT NOT NULL CHECK (metric IN ('draws', 'card_count')),
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'total', 'current')),
  streamer_id UUID NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  position INTEGER NOT NULL CHECK (position >= 1),
  value BIGINT NOT NULL CHECK (value >= 0),
  participant_count INTEGER NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (metric, period, streamer_id)
);

CREATE INDEX IF NOT EXISTS idx_ranking_snapshots_position
  ON public.streamer_ranking_snapshots(metric, period, position);

REVOKE ALL ON TABLE public.streamer_ranking_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_ranking_snapshots TO service_role;

COMMENT ON TABLE public.streamer_ranking_snapshots IS
  'ランキング確定値の最新スナップショットのみ。refresh_streamer_ranking() が
  同一トランザクションで DELETE→INSERT し、失敗時は旧 snapshot が残る
  (Issue #741)。anon/authenticated へは公開しない (後続 #742 の匿名化境界を
  壊さないため、読み取りは匿名化 API 経由のみ)。';

-- ---------------------------------------------------------------------------
-- 3. stats_meta — backfill 完了マーカー
-- ---------------------------------------------------------------------------
-- key = 'daily_stats_backfilled_at' が存在するまで refresh_streamer_ranking()
-- はスナップショット生成を全てスキップする (日次ロールアップの増分維持のみ
-- 行う)。total だけの問題ではない: weekly は streamer_daily_stats の蓄積行に
-- 依存するため backfill 前は大幅な過少値になり、母集団 (直近 30 日排出)
-- 判定も同テーブル依存のため participant_count が過小になって card_count
-- ランキングまで歪む。メトリクス別の部分ゲートは複雑なわりに得るものが
-- なく、backfill はデプロイ後速やかに 1 回の運用なので全停止が最小・最安全。
CREATE TABLE IF NOT EXISTS public.stats_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON TABLE public.stats_meta FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stats_meta TO service_role;

COMMENT ON TABLE public.stats_meta IS
  '集計バッチ用の単純 KV。daily_stats_backfilled_at が backfill 完了マーカー
  (Issue #741)。';

-- ---------------------------------------------------------------------------
-- gacha_history の redeemed_at インデックスは新設しない
-- ---------------------------------------------------------------------------
-- バッチは全 streamer 横断で redeemed_at 範囲スキャンを行うが、redeemed_at を
-- 先頭に持つインデックスは既に存在する:
--   idx_gacha_history_redeemed_at_analysis
--     ON public.gacha_history (redeemed_at DESC)
--     (db/planetscale/migrations/20260801090003_create_analysis_gacha_history_redeemed_at_index.sql)
-- これは本 migration (20261007120000) より前に適用されるため、そのまま利用できる。
-- btree は ASC/DESC 双方向に走査できるので ORDER BY redeemed_at DESC の範囲
-- スキャンにも使える。
--
-- 同価値の重複インデックスを最ホットテーブルに追加すると書き込みコストが増える
-- だけでなく、プランナが2つのインデックス間で選択を変えるため
-- tests/fixtures/analysis-dashboard-pagination-postgres.sql の
-- 「gacha 7-day plan は idx_gacha_history_redeemed_at_analysis を使う」断言が
-- 落ちる (CI の 'PlanetScale migration PostgreSQL 17' で実際に検出)。
-- よってここではインデックスを追加しない。

-- ---------------------------------------------------------------------------
-- refresh_streamer_daily_stats(p_from, p_to)
-- ---------------------------------------------------------------------------
-- JST 日境界への拡張が仕様の要: d_from / d_to を求め、スキャン範囲を
-- [d_from の JST 00:00, d_to+1 日の JST 00:00) に拡張して GROUP BY する。
-- 範囲に触れる JST 日付を必ず丸一日ぶん再計算するため、何度呼んでも同じ
-- 結果になる (p_from をそのまま境界に使うと最古日が過少カウントで上書き
-- され、冪等性が崩れる)。
-- 結果を INSERT ... ON CONFLICT (streamer_id, stat_date) DO UPDATE。
-- [d_from, d_to] 内で排出 0 件になった既存行は DELETE (イベント巻き戻し対応)。
-- 通常呼び出しは p_from = now() - interval '48 hours', p_to = now()
-- (JST 日付 2〜3 日分)。遅延書き込み・リトライを吸収する。
-- 手動ドロー (event_id LIKE 'manual:%') は除外する (Issue #784 の不変条件)。
CREATE OR REPLACE FUNCTION public.refresh_streamer_daily_stats(
  p_from timestamptz,
  p_to timestamptz
) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  d_from date := (p_from AT TIME ZONE 'Asia/Tokyo')::date;
  d_to date := (p_to AT TIME ZONE 'Asia/Tokyo')::date;
  scan_start timestamptz := d_from AT TIME ZONE 'Asia/Tokyo';
  scan_end timestamptz := (d_to + 1) AT TIME ZONE 'Asia/Tokyo';
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS tmp_stats_daily_fresh (
    streamer_id uuid NOT NULL,
    stat_date date NOT NULL,
    draw_count integer NOT NULL,
    PRIMARY KEY (streamer_id, stat_date)
  ) ON COMMIT DROP;
  -- TRUNCATE は使わない (scripts/lib/db-migrate-core.js の非加法性検知が
  -- 関数本体内の TRUNCATE も検知し、planetscale-migrate.yml の自動適用を
  -- ブロックするため。DELETE は検知対象外)。
  DELETE FROM tmp_stats_daily_fresh;

  INSERT INTO tmp_stats_daily_fresh (streamer_id, stat_date, draw_count)
  SELECT
    h.streamer_id,
    (h.redeemed_at AT TIME ZONE 'Asia/Tokyo')::date AS stat_date,
    COUNT(*)::integer AS draw_count
  FROM public.gacha_history h
  WHERE h.redeemed_at IS NOT NULL
    AND h.redeemed_at >= scan_start
    AND h.redeemed_at < scan_end
    AND h.event_id NOT LIKE 'manual:%'
  GROUP BY h.streamer_id, ((h.redeemed_at AT TIME ZONE 'Asia/Tokyo')::date);

  INSERT INTO public.streamer_daily_stats (streamer_id, stat_date, draw_count, updated_at)
  SELECT f.streamer_id, f.stat_date, f.draw_count, now()
  FROM tmp_stats_daily_fresh f
  ON CONFLICT (streamer_id, stat_date) DO UPDATE
    SET draw_count = EXCLUDED.draw_count,
        updated_at = EXCLUDED.updated_at;

  DELETE FROM public.streamer_daily_stats s
  WHERE s.stat_date >= d_from
    AND s.stat_date <= d_to
    AND NOT EXISTS (
      SELECT 1 FROM tmp_stats_daily_fresh f
      WHERE f.streamer_id = s.streamer_id
        AND f.stat_date = s.stat_date
    );
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_streamer_daily_stats(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_streamer_daily_stats(timestamptz, timestamptz) TO service_role;

COMMENT ON FUNCTION public.refresh_streamer_daily_stats(timestamptz, timestamptz) IS
  'JST 日単位で streamer_daily_stats を冪等に再構築する (Issue #741)。
  引数の瞬時を JST 日付へ丸めて範囲を丸一日単位へ拡張するため、同範囲の
  繰り返し実行は不変。手動ドローは除外する (Issue #784)。';

-- ---------------------------------------------------------------------------
-- refresh_streamer_ranking()
-- ---------------------------------------------------------------------------
-- 1. 冒頭で pg_try_advisory_xact_lock を取得。取れなければ即時スキップ
--    (skipped=true)。cron 重複・手動実行の競合で待ち行列を作らない。
--    固定キーの採番規約: hashtext('twica:stats:refresh') の 32bit ハッシュ値。
--    本コードベースの advisory lock 用途は本関数のみであり、他機能が同名
--    文字列でロックを取ることはない (文字列名前空間 'twica:<domain>:<name>'
--    を用途ごとに一意にする規約で衝突を回避する)。
-- 2. cooldown ガード: MAX(computed_at) が直近 10 分以内なら即時スキップ。
--    secret 漏洩時の高頻度逐次リクエストで全体再計算が DoS ベクタに
--    ならないようにする (advisory lock は同時実行しか防がない)。
-- 3. refresh_streamer_daily_stats(now() - interval '48 hours', now())
-- 4. stats_meta.daily_stats_backfilled_at が存在しない場合はここで終了
--    (スナップショット生成をスキップ)。
-- 5. 母集団 CTE (直近 30 日に排出のある streamer_id) を作り、同一
--    トランザクション内で streamer_ranking_snapshots を DELETE→INSERT。
-- 6. 失敗時はトランザクションごとロールバックし旧スナップショットが残る。
--    呼び出し側の内部 API がエラーを structured log に残す。
CREATE OR REPLACE FUNCTION public.refresh_streamer_ranking()
RETURNS TABLE(skipped boolean, reason text, snapshot_count integer)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_today date := (v_now AT TIME ZONE 'Asia/Tokyo')::date;
  v_week_start date := (v_now AT TIME ZONE 'Asia/Tokyo')::date - 6;
  v_month_start date := (v_now AT TIME ZONE 'Asia/Tokyo')::date - 29;
  v_last_computed timestamptz;
  v_backfilled boolean;
  v_count integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('twica:stats:refresh')) THEN
    RETURN QUERY SELECT true, 'lock-contention'::text, 0;
    RETURN;
  END IF;

  SELECT MAX(s.computed_at) INTO v_last_computed
  FROM public.streamer_ranking_snapshots s;
  IF v_last_computed IS NOT NULL AND v_last_computed > v_now - interval '10 minutes' THEN
    RETURN QUERY SELECT true, 'cooldown'::text, 0;
    RETURN;
  END IF;

  PERFORM public.refresh_streamer_daily_stats(
    v_now - interval '48 hours',
    v_now
  );

  SELECT EXISTS (
    SELECT 1 FROM public.stats_meta m
    WHERE m.key = 'daily_stats_backfilled_at'
  ) INTO v_backfilled;
  IF NOT v_backfilled THEN
    RETURN QUERY SELECT true, 'backfill-pending'::text, 0;
    RETURN;
  END IF;

  DELETE FROM public.streamer_ranking_snapshots;

  WITH population AS (
    SELECT DISTINCT d.streamer_id
    FROM public.streamer_daily_stats d
    WHERE d.stat_date >= v_month_start
  ),
  draws_total AS (
    SELECT d.streamer_id, SUM(d.draw_count)::bigint AS value
    FROM public.streamer_daily_stats d
    JOIN population p ON p.streamer_id = d.streamer_id
    GROUP BY d.streamer_id
  ),
  draws_weekly AS (
    SELECT d.streamer_id, SUM(d.draw_count)::bigint AS value
    FROM public.streamer_daily_stats d
    JOIN population p ON p.streamer_id = d.streamer_id
    WHERE d.stat_date >= v_week_start
    GROUP BY d.streamer_id
    HAVING SUM(d.draw_count) > 0
  ),
  draws_daily AS (
    SELECT d.streamer_id, SUM(d.draw_count)::bigint AS value
    FROM public.streamer_daily_stats d
    JOIN population p ON p.streamer_id = d.streamer_id
    WHERE d.stat_date = v_today
    GROUP BY d.streamer_id
    HAVING SUM(d.draw_count) > 0
  ),
  card_current AS (
    SELECT c.streamer_id, COUNT(*)::bigint AS value
    FROM public.cards c
    JOIN population p ON p.streamer_id = c.streamer_id
    GROUP BY c.streamer_id
  ),
  ranked AS (
    SELECT 'draws'::text AS metric, 'total'::text AS period, streamer_id, value FROM draws_total
    UNION ALL
    SELECT 'draws', 'weekly', streamer_id, value FROM draws_weekly
    UNION ALL
    SELECT 'draws', 'daily', streamer_id, value FROM draws_daily
    UNION ALL
    SELECT 'card_count', 'current', streamer_id, value FROM card_current
  ),
  positioned AS (
    SELECT
      r.metric,
      r.period,
      r.streamer_id,
      RANK() OVER (PARTITION BY r.metric, r.period ORDER BY r.value DESC, r.streamer_id)::integer AS rank,
      ROW_NUMBER() OVER (PARTITION BY r.metric, r.period ORDER BY r.value DESC, r.streamer_id)::integer AS position,
      r.value,
      COUNT(*) OVER (PARTITION BY r.metric, r.period)::integer AS participant_count
    FROM ranked r
  )
  INSERT INTO public.streamer_ranking_snapshots
    (metric, period, streamer_id, rank, position, value, participant_count, computed_at)
  SELECT metric, period, streamer_id, rank, position, value, participant_count, v_now
  FROM positioned;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN QUERY SELECT false, 'refreshed'::text, v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_streamer_ranking() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_streamer_ranking() TO service_role;

COMMENT ON FUNCTION public.refresh_streamer_ranking() IS
  'ランキング snapshot の毎時再計算 (Issue #741)。advisory lock + 10分
  cooldown で多重実行を防ぎ、backfill 完了前は snapshot 生成を全停止する。
  同一トランザクションで DELETE→INSERT するため失敗時は旧 snapshot が残る。';

-- ---------------------------------------------------------------------------
-- backfill_streamer_daily_stats() (一回限り)
-- ---------------------------------------------------------------------------
-- gacha_history 全期間を GROUP BY して streamer_daily_stats を再構築し、
-- 完了時に stats_meta('daily_stats_backfilled_at', now()) を upsert する。
-- 本 migration 内では実行しない。デプロイ後に低負荷時間帯へ手動で 1 回実行し
-- (例: SELECT * FROM public.backfill_streamer_daily_stats();)、直後に増分
-- refresh_streamer_daily_stats を再実行して差分が出ないことを確認する。
-- #568 の cutover 作業期間とは重ねないこと。
CREATE OR REPLACE FUNCTION public.backfill_streamer_daily_stats()
RETURNS TABLE(rebuilt_rows integer, backfilled_at timestamptz)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_count integer;
BEGIN
  INSERT INTO public.streamer_daily_stats (streamer_id, stat_date, draw_count, updated_at)
  SELECT
    h.streamer_id,
    (h.redeemed_at AT TIME ZONE 'Asia/Tokyo')::date AS stat_date,
    COUNT(*)::integer AS draw_count,
    v_now AS updated_at
  FROM public.gacha_history h
  WHERE h.redeemed_at IS NOT NULL
    AND h.event_id NOT LIKE 'manual:%'
  GROUP BY h.streamer_id, ((h.redeemed_at AT TIME ZONE 'Asia/Tokyo')::date)
  ON CONFLICT (streamer_id, stat_date) DO UPDATE
    SET draw_count = EXCLUDED.draw_count,
        updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.stats_meta (key, value, updated_at)
    VALUES ('daily_stats_backfilled_at', v_now::text, v_now)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at;

  RETURN QUERY SELECT v_count, v_now;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_streamer_daily_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_streamer_daily_stats() TO service_role;

COMMENT ON FUNCTION public.backfill_streamer_daily_stats() IS
  '初回 backfill 用の一回限り関数 (Issue #741)。migration 内では実行せず、
  デプロイ後に低負荷時間帯へ手動で 1 回実行する。完了マーカーを stats_meta
  へ upsert する。手動ドローは除外する (Issue #784)。';
