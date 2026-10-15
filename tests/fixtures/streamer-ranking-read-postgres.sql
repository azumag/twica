\set ON_ERROR_STOP on

-- Issue #742 (子B) の読み取り関数 public.get_streamer_ranking(uuid) を実 PostgreSQL 17 で検証する。
--
-- CI の "PlanetScale migration PostgreSQL 17" job が全 migration 適用後に本 fixture を実行し、
-- 末尾の ROLLBACK で投入データを残さない（後続の fixture / integration test へ影響させない）。
--
-- 検証対象（Issue #742 の受け入れ条件）:
--   * 応答 contract（4 メトリクス・rank/position の使い分け・固定順）
--   * 匿名性: 応答 JSON に他チャンネルの streamer_id / username / display_name が一切現れない
--   * top = position <= 10、neighbors = self の position ± 2 から top を除いたもの
--   * self フォールバック（母集団外の配信者でも自分の累計値だけは返す）
--   * 世代一貫性: self/top/neighbors が同じ computed_at 世代の行から返ること
--   * insufficientData 境界（participant_count 4 と 5）
--   * snapshot 0 行（backfill 前）でも contract どおりの 200 相当の値になること
--   * anon / authenticated が関数も生 snapshot も読めないこと
--
-- 母集団は「直近 30 日（JST）に排出のある配信者」（子A の refresh_streamer_ranking() 仕様）。
-- s01..s13 が母集団、s14 は母集団外（40 日前の排出のみ）として self フォールバックを検証する。

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. 集計対象の初期化
-- ---------------------------------------------------------------------------
-- CI では先行する fixture（transaction: required で `psql -1` 実行のもの、
-- paced-multi-draw-chat / pack-completion-rewards / add-card-trading /
-- redemption-ranking-exclusions 等）が streamers / gacha_history へデータを
-- コミットしたまま残っている。本 fixture は「母集団＝自分の 13 配信者」という
-- 固定の期待値（participant_count / snapshot 行数 / 順位）を検証するため、
-- 先に集計の入力と出力を空にしてから自分のデータだけを投入する。
--
-- すべて同一トランザクション内の変更であり、末尾の ROLLBACK で元に戻るため
-- 先行 fixture のデータは後続 step へそのまま残る（他の streamers / cards は
-- 母集団判定に使われないので消さない = FK 影響を最小化する）。
DELETE FROM public.streamer_ranking_snapshots;
DELETE FROM public.streamer_daily_stats;
DELETE FROM public.stats_meta;
DELETE FROM public.gacha_history;

-- ---------------------------------------------------------------------------
-- 1. 配信者 / カード / 排出履歴の投入
-- ---------------------------------------------------------------------------

INSERT INTO public.streamers (id, twitch_user_id, twitch_username, twitch_display_name)
SELECT
  ('74000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'zr-fixture-' || lpad(i::text, 2, '0'),
  'zrfixture-' || lpad(i::text, 2, '0'),
  'ZR Fixture ' || lpad(i::text, 2, '0')
FROM generate_series(1, 14) AS i;

-- カード枚数（card_count/current の値）。s01..s13 が母集団なので参加者 13 人（>= 5 で sufficient）、
-- s14 は母集団外なので snapshot には現れず self フォールバックの検証対象になる。
WITH card_plan(idx, card_count) AS (
  VALUES
    (1, 5), (2, 3), (3, 2), (4, 2), (5, 2),
    (6, 1), (7, 1), (8, 1), (9, 1), (10, 1), (11, 1), (12, 1), (13, 1),
    (14, 4)
),
card_series AS (
  SELECT p.idx, k
  FROM card_plan p, LATERAL generate_series(1, p.card_count) AS k
)
INSERT INTO public.cards (id, streamer_id, name, rarity, drop_rate, is_active)
SELECT
  ('74000000-0000-4000-8000-' || lpad((cs.idx * 100 + cs.k)::text, 12, '0'))::uuid,
  ('74000000-0000-4000-8000-' || lpad(cs.idx::text, 12, '0'))::uuid,
  'ZR Card ' || cs.idx || '-' || cs.k,
  'common',
  0.5,
  true
FROM card_series cs;

-- 排出履歴。JST 日付基準で「40 日前（母集団外）」「20 日前（累計のみ）」「3 日前（週次）」
-- 「今日（日次）」の4バケットに分けて投入し、draws の total/weekly/daily を固定値にする。
--
-- 時刻は JST 12:00 固定にする。daily の集計範囲は [今日 00:00 JST, 明日 00:00 JST) なので、
-- fixture 実行時刻が何時でも「今日 12:00」は必ず範囲内に入り（= 結果が実行時刻に依存しない）、
-- かつ today バケットが未来時刻でも集計対象から漏れない。
WITH buckets(bucket, days_ago) AS (
  VALUES ('d40', 40), ('d20', 20), ('d3', 3), ('today', 0)
),
draw_plan(idx, bucket, draw_count) AS (
  VALUES
    (1, 'd20', 20), (1, 'd3', 20), (1, 'today', 10),
    (2, 'd20', 30), (2, 'd3', 5),  (2, 'today', 5),
    (3, 'd20', 35), (3, 'd3', 5),
    (4, 'd20', 25), (4, 'd3', 5),
    (5, 'd20', 20), (5, 'd3', 5),
    (6, 'd20', 15), (6, 'd3', 5),
    (7, 'd20', 10), (7, 'd3', 5),
    (8, 'd20', 5),  (8, 'd3', 5),
    (9, 'd20', 4),  (9, 'd3', 4),
    (10, 'd20', 3), (10, 'd3', 3),
    (11, 'd20', 2), (11, 'd3', 3),
    (12, 'd20', 1), (12, 'd3', 3),
    (13, 'd20', 1), (13, 'd3', 2),
    (14, 'd40', 20)
),
resolved AS (
  SELECT
    dp.idx,
    dp.bucket,
    dp.draw_count,
    (
      (
        (now() AT TIME ZONE 'Asia/Tokyo')::date - b.days_ago
      )::timestamp + interval '12 hours'
    ) AT TIME ZONE 'Asia/Tokyo' AS redeemed_at
  FROM draw_plan dp
  JOIN buckets b ON b.bucket = dp.bucket
)
INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id, redeemed_at, event_id, reward_cost
)
SELECT
  extensions.uuid_generate_v4(),
  'zr-user-' || r.idx || '-' || r.bucket || '-' || g,
  'zruser' || r.idx || '_' || g,
  -- 各配信者の 1 枚目のカード（gacha_history.card_id は cards への FK）
  ('74000000-0000-4000-8000-' || lpad((r.idx * 100 + 1)::text, 12, '0'))::uuid,
  ('74000000-0000-4000-8000-' || lpad(r.idx::text, 12, '0'))::uuid,
  r.redeemed_at,
  'zrfixture-' || r.idx || '-' || r.bucket || '-' || g,
  0
FROM resolved r, LATERAL generate_series(1, r.draw_count) AS g;

-- 手動ドロー（event_id LIKE 'manual:%'）は集計から除外される（#784 の不変条件）。
-- これが壊れると s12 が total 1 位・daily 参加者に化けるため、除外の回帰検出になる。
INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id, redeemed_at, event_id, reward_cost
)
SELECT
  extensions.uuid_generate_v4(),
  'zr-user-12-manual-' || g,
  'zruser12_manual_' || g,
  ('74000000-0000-4000-8000-' || lpad((12 * 100 + 1)::text, 12, '0'))::uuid,
  '74000000-0000-4000-8000-000000000012'::uuid,
  (
    (
      (now() AT TIME ZONE 'Asia/Tokyo')::date - (CASE WHEN g % 2 = 0 THEN 20 ELSE 0 END)
    )::timestamp + interval '12 hours'
  ) AT TIME ZONE 'Asia/Tokyo',
  'manual:zrfixture-12-' || g,
  0
FROM generate_series(1, 100) AS g;

-- ---------------------------------------------------------------------------
-- 2. 本番と同じ経路で集計する（backfill → 毎時集計）
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE zr_backfill_result AS
SELECT * FROM public.backfill_streamer_daily_stats();

CREATE TEMP TABLE zr_refresh_result AS
SELECT * FROM public.refresh_streamer_ranking();

DO $$
DECLARE
  v_skipped boolean;
  v_reason text;
  v_snapshot_count integer;
BEGIN
  SELECT skipped, reason, snapshot_count
    INTO v_skipped, v_reason, v_snapshot_count
  FROM zr_refresh_result;

  IF v_skipped OR v_reason <> 'refreshed' THEN
    RAISE EXCEPTION 'refresh_streamer_ranking() が snapshot を作らなかった: skipped=%, reason=%',
      v_skipped, v_reason;
  END IF;

  -- 母集団 13 人 × 4 メトリクス = 52 行（draws total/weekly 13 + draws daily 2 + card_count 13）
  IF v_snapshot_count <> 41 THEN
    RAISE EXCEPTION 'snapshot 行数が想定と異なる: %（期待 41）', v_snapshot_count;
  END IF;

  IF (SELECT count(*) FROM public.gacha_history WHERE event_id LIKE 'manual:%') <> 100 THEN
    RAISE EXCEPTION '手動ドローの投入が行われていない（除外検証が空振りする）';
  END IF;

  -- 手動ドロー除外（#784）
  IF (SELECT sum(draw_count) FROM public.streamer_daily_stats
      WHERE streamer_id = '74000000-0000-4000-8000-000000000012'::uuid) <> 4 THEN
    RAISE EXCEPTION '手動ドローが daily 集計から除外されていない（s12 の累計が 4 でない）';
  END IF;

  -- 母集団 13 人・s14 は 30 日窓の外
  IF (SELECT count(DISTINCT streamer_id) FROM public.streamer_daily_stats
      WHERE stat_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date - 29) <> 13 THEN
    RAISE EXCEPTION '母集団（直近30日）が 13 人でない';
  END IF;

  -- 世代一貫性の前提: 1 回の refresh で入る snapshot の computed_at は全行同一
  IF (SELECT count(DISTINCT computed_at) FROM public.streamer_ranking_snapshots) <> 1 THEN
    RAISE EXCEPTION 'snapshot の computed_at が単一世代でない';
  END IF;

  -- backfill が実際に日次ロールアップを構築したこと（空振り検出）
  IF (SELECT rebuilt_rows FROM zr_backfill_result) <= 0 THEN
    RAISE EXCEPTION 'backfill_streamer_daily_stats() が1行も構築していない';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. 応答 contract / 順位 / top / neighbors / self フォールバック
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE zr_json AS
SELECT
  '74000000-0000-4000-8000-000000000011'::uuid AS self_id, -- 母集団内・position 11（近傍あり）
  public.get_streamer_ranking('74000000-0000-4000-8000-000000000011'::uuid) AS payload;

-- contract の形（キー集合）と値の検証
DO $$
DECLARE
  v_payload jsonb;
  v_self_id uuid;
  v_expected_order text[];
  v_actual_order text[];
BEGIN
  SELECT payload, self_id INTO v_payload, v_self_id FROM zr_json;

  -- トップレベル: schemaVersion / computedAt / rankings の 3 キーのみ
  IF (SELECT count(*) FROM jsonb_object_keys(v_payload)) <> 3
     OR (v_payload - 'schemaVersion' - 'computedAt' - 'rankings') <> '{}'::jsonb THEN
    RAISE EXCEPTION '応答のトップレベルキーが contract と不一致: %', v_payload;
  END IF;
  IF (v_payload->>'schemaVersion')::int <> 1 THEN
    RAISE EXCEPTION 'schemaVersion が 1 でない: %', v_payload->>'schemaVersion';
  END IF;
  IF jsonb_typeof(v_payload->'computedAt') <> 'string' THEN
    RAISE EXCEPTION 'computedAt が ISO 文字列でない: %', v_payload->'computedAt';
  END IF;
  IF v_payload->>'computedAt' <> to_char(
       (SELECT max(computed_at) FROM public.streamer_ranking_snapshots) AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION 'computedAt が最新 snapshot と一致しない: %', v_payload->>'computedAt';
  END IF;

  -- 4 エントリの固定順
  SELECT array_agg(e->>'metric' || '/' || (e->>'period'))
    INTO v_actual_order
  FROM jsonb_array_elements(v_payload->'rankings') e;
  v_expected_order := ARRAY['draws/total', 'draws/weekly', 'draws/daily', 'card_count/current'];
  IF v_actual_order <> v_expected_order THEN
    RAISE EXCEPTION 'rankings の順序が contract と不一致: %', v_actual_order;
  END IF;

  -- 各エントリのキー集合（7 キー・過不足なし）
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload->'rankings') e
    WHERE (SELECT count(*) FROM jsonb_object_keys(e)) <> 7
       OR (e - 'metric' - 'period' - 'participantCount' - 'insufficientData'
              - 'self' - 'top' - 'neighbors') <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'エントリのキー集合が contract と不一致: %', v_payload->'rankings';
  END IF;

  -- self のキー集合（3 キー）
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload->'rankings') e
    WHERE e->'self' <> 'null'::jsonb
      AND (
        (SELECT count(*) FROM jsonb_object_keys(e->'self')) <> 3
        -- 注意: `e->'self' - 'value'` は `e -> ('self' - 'value')` と解釈される
        -- （`-` が `->` より結合順位が高い）ため、必ず括弧で括る。
        OR ((e->'self') - 'value' - 'rank' - 'percentile') <> '{}'::jsonb
      )
  ) THEN
    RAISE EXCEPTION 'self のキー集合が contract と不一致';
  END IF;

  -- top / neighbors の行は rank / value / isSelf の 3 キーのみ
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_payload->'rankings') AS entries(e),
         LATERAL jsonb_array_elements(e->'top' || e->'neighbors') AS ranked(r)
    WHERE (SELECT count(*) FROM jsonb_object_keys(r)) <> 3
       OR (r - 'rank' - 'value' - 'isSelf') <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'top/neighbors の行のキー集合が contract と不一致';
  END IF;
END $$;

-- draws/total: self は position 11（rank 11）。top 10 行 + neighbors 3 行（11,12,13）。
DO $$
DECLARE
  v_entry jsonb;
  v_top jsonb;
  v_neighbors jsonb;
BEGIN
  SELECT e INTO v_entry
  FROM zr_json j, jsonb_array_elements(j.payload->'rankings') e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';

  IF (v_entry->>'participantCount')::int <> 13 THEN
    RAISE EXCEPTION 'draws/total の participantCount が 13 でない: %', v_entry->>'participantCount';
  END IF;
  IF (v_entry->>'insufficientData')::boolean THEN
    RAISE EXCEPTION 'draws/total が insufficientData=true（参加者 13 では false のはず）';
  END IF;
  IF v_entry->'self' <> jsonb_build_object('value', 5, 'rank', 11, 'percentile', 23) THEN
    RAISE EXCEPTION 'draws/total の self が想定と不一致: %', v_entry->'self';
  END IF;

  v_top := v_entry->'top';
  IF jsonb_array_length(v_top) <> 10 THEN
    RAISE EXCEPTION 'top が 10 行でない: %', jsonb_array_length(v_top);
  END IF;
  -- rank は snapshot に入っている表示用順位をそのまま透過させる。同値時の RANK の
  -- 定義は子A 側の修正（PR #1775 / 20261007180000_fix_streamer_ranking_ties.sql）で
  -- 変わりうるため、期待値をハードコードせず現世代の snapshot と突き合わせる
  -- （本関数の責務は「position で選び、rank をそのまま返す」ことの検証）。
  IF (SELECT array_agg((t.r->>'rank')::int ORDER BY t.ord)
        FROM jsonb_array_elements(v_top) WITH ORDINALITY AS t(r, ord))
     <> (SELECT array_agg(s.rank ORDER BY s.position)
           FROM public.streamer_ranking_snapshots s
          WHERE s.metric = 'draws' AND s.period = 'total' AND s.position <= 10) THEN
    RAISE EXCEPTION 'top の rank 列が snapshot と一致しない: %', v_top;
  END IF;
  IF (SELECT array_agg((r->>'value')::bigint ORDER BY ord)
        FROM jsonb_array_elements(v_top) WITH ORDINALITY AS t(r, ord))
     <> ARRAY[50, 40, 40, 30, 25, 20, 15, 10, 8, 6]::bigint[] THEN
    RAISE EXCEPTION 'top の value 列が想定と不一致: %', v_top;
  END IF;
  -- top 内に自分はいない（position 11）
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_top) r WHERE (r->>'isSelf')::boolean) THEN
    RAISE EXCEPTION 'position 11 の self が top に混入している';
  END IF;

  -- neighbors は position 11〜13（top の 1〜10 を除いた残り）。自分の行を含む。
  v_neighbors := v_entry->'neighbors';
  IF jsonb_array_length(v_neighbors) <> 3 THEN
    RAISE EXCEPTION 'neighbors が 3 行でない: %', v_neighbors;
  END IF;
  IF (SELECT array_agg((r->>'rank')::int ORDER BY ord)
        FROM jsonb_array_elements(v_neighbors) WITH ORDINALITY AS t(r, ord))
     <> ARRAY[11, 12, 13] THEN
    RAISE EXCEPTION 'neighbors の rank 列が想定と不一致: %', v_neighbors;
  END IF;
  IF (SELECT array_agg((r->>'value')::bigint ORDER BY ord)
        FROM jsonb_array_elements(v_neighbors) WITH ORDINALITY AS t(r, ord))
     <> ARRAY[5, 4, 3]::bigint[] THEN
    RAISE EXCEPTION 'neighbors の value 列が想定と不一致: %', v_neighbors;
  END IF;
  -- 自分の位置は近傍リストの中で強調できる（isSelf は 1 行だけ）
  IF (SELECT count(*) FROM jsonb_array_elements(v_neighbors) r WHERE (r->>'isSelf')::boolean) <> 1 THEN
    RAISE EXCEPTION 'neighbors の isSelf が 1 行でない: %', v_neighbors;
  END IF;
  IF (v_neighbors->0->>'isSelf')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'neighbors の並び (11,12,13) と isSelf の位置が一致しない: %', v_neighbors;
  END IF;

  -- 世代一貫性: 応答の self と各 rank 行が snapshot の現世代と一致する
  -- （本関数は単一 statement なので、snapshot が別世代になればこの等式が崩れる）
  IF NOT EXISTS (
    SELECT 1
    FROM public.streamer_ranking_snapshots s
    WHERE s.metric = 'draws' AND s.period = 'total'
      AND s.streamer_id = (SELECT self_id FROM zr_json)
      AND (v_entry->'self'->>'value')::bigint = s.value
      AND (v_entry->'self'->>'rank')::int = s.rank
  ) THEN
    RAISE EXCEPTION 'self の値/順位が snapshot と一致しない（世代不一致の疑い）';
  END IF;
  IF (SELECT array_agg((t.r->>'rank')::int ORDER BY t.ord)
        FROM jsonb_array_elements(v_top) WITH ORDINALITY AS t(r, ord))
     <> (SELECT array_agg(s.rank ORDER BY s.position)
           FROM public.streamer_ranking_snapshots s
          WHERE s.metric = 'draws' AND s.period = 'total' AND s.position <= 10) THEN
    RAISE EXCEPTION 'top の各行が snapshot の position 順と一致しない（世代不一致の疑い）';
  END IF;
END $$;

-- self が top 圏内（position 8）: neighbors は空、top 内に isSelf が 1 行
DO $$
DECLARE
  v_entry jsonb;
BEGIN
  SELECT e INTO v_entry
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000008'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';

  IF jsonb_array_length(v_entry->'neighbors') <> 0 THEN
    RAISE EXCEPTION 'top 圏内の self で neighbors が空でない: %', v_entry->'neighbors';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_entry->'top') r WHERE (r->>'isSelf')::boolean) <> 1 THEN
    RAISE EXCEPTION 'top 圏内の self が top に 1 行だけ現れない: %', v_entry->'top';
  END IF;
  IF v_entry->'self' <> jsonb_build_object('value', 10, 'rank', 8, 'percentile', 46) THEN
    RAISE EXCEPTION 'top 圏内 self の応答が想定と不一致: %', v_entry->'self';
  END IF;
END $$;

-- 最下位（position 13）: neighbors は 11〜13（自分の行が末尾）
DO $$
DECLARE
  v_entry jsonb;
BEGIN
  SELECT e INTO v_entry
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000013'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';

  IF jsonb_array_length(v_entry->'neighbors') <> 3
     OR (v_entry->'neighbors'->2->>'isSelf')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION '最下位 self の neighbors が想定と不一致: %', v_entry->'neighbors';
  END IF;
  IF (v_entry->'neighbors'->0->>'rank')::int <= 10 THEN
    RAISE EXCEPTION 'neighbors に top の行（position <= 10）が混入している: %', v_entry->'neighbors';
  END IF;
END $$;

-- 同値の値（40 が 2 人）でも表示順が決定的で、percentile は表示 rank と整合する。
-- 同値 rank の付け方（RANK vs 一意順位）は子A 側の実装に依存するため、
-- 期待値を固定せず「self の rank から percentile が導出されている」ことを検証する。
DO $$
DECLARE
  v_s02 jsonb;
  v_s03 jsonb;
  v_s03_rank integer;
BEGIN
  SELECT e INTO v_s02
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000002'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';
  SELECT e INTO v_s03
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000003'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';

  IF (v_s02->'self'->>'value')::bigint <> 40 OR (v_s03->'self'->>'value')::bigint <> 40 THEN
    RAISE EXCEPTION '同値 40 の self 値が想定と不一致: s02=%, s03=%', v_s02->'self', v_s03->'self';
  END IF;
  IF (v_s02->'self'->>'rank')::int <> 2 THEN
    RAISE EXCEPTION 's02 の rank が 2 でない: %', v_s02->'self';
  END IF;
  -- s02 が上位（rank 2）なので s03 の rank は 2 以上。値が同順位になるかは
  -- 子A の RANK 定義次第だが、順位が入れ替わってはいけない
  IF (v_s03->'self'->>'rank')::int < (v_s02->'self'->>'rank')::int THEN
    RAISE EXCEPTION '同値 40 で並び順が逆転している: s02=%, s03=%', v_s02->'self', v_s03->'self';
  END IF;
  -- percentile は自分が表示している rank から導出される（rank=1 -> 100, 最下位 -> 100/n）
  v_s03_rank := (v_s03->'self'->>'rank')::int;
  IF (v_s03->'self'->>'percentile')::int
     <> round(100.0 * (13 - v_s03_rank + 1) / 13)::int THEN
    RAISE EXCEPTION 'percentile が表示 rank と整合しない: %', v_s03->'self';
  END IF;
  -- 表示順の決定性: self が誰でも top の並び（値）は同じ
  IF (SELECT array_agg((r->>'value')::bigint ORDER BY ord)
        FROM jsonb_array_elements(v_s02->'top') WITH ORDINALITY AS t(r, ord))
     <> (SELECT array_agg((r->>'value')::bigint ORDER BY ord)
           FROM jsonb_array_elements(v_s03->'top') WITH ORDINALITY AS t(r, ord)) THEN
    RAISE EXCEPTION '同値でも top の並びが self によって変わる（順序が決定的でない）';
  END IF;
END $$;

-- self フォールバック: 母集団外（直近30日に排出なし）の s14 でも自分の累計値は返す
DO $$
DECLARE
  v_total jsonb;
  v_cards jsonb;
  v_daily jsonb;
BEGIN
  SELECT e INTO v_total
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000014'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';
  SELECT e INTO v_cards
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000014'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'card_count' AND e->>'period' = 'current';
  SELECT e INTO v_daily
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000014'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'daily';

  -- 40 日前の 20 回が streamer_daily_stats から補完される（snapshot には行が無い）
  IF v_total->'self' <> jsonb_build_object('value', 20, 'rank', NULL, 'percentile', NULL) THEN
    RAISE EXCEPTION '母集団外 self の draws/total フォールバックが想定と不一致: %', v_total->'self';
  END IF;
  IF (v_total->>'insufficientData')::boolean THEN
    RAISE EXCEPTION '母集団外でも participants は 13 なので insufficientData=false のはず';
  END IF;
  IF jsonb_array_length(v_total->'top') <> 10 THEN
    RAISE EXCEPTION '母集団外 self でも top は返るはず: %', v_total->'top';
  END IF;
  -- cards 4 枚も同様に自分の行から補完される
  IF v_cards->'self' <> jsonb_build_object('value', 4, 'rank', NULL, 'percentile', NULL) THEN
    RAISE EXCEPTION '母集団外 self の card_count フォールバックが想定と不一致: %', v_cards->'self';
  END IF;
  -- daily/weekly は母集団外なら必ず 0 回なので self は null
  IF v_daily->'self' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'daily の self が null でない: %', v_daily->'self';
  END IF;
END $$;

-- 手動ドロー除外の回帰検出: s12 の累計は 4（manual: 200 回は数えない）、日次には現れない
DO $$
DECLARE
  v_total jsonb;
  v_daily jsonb;
BEGIN
  SELECT e INTO v_total
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000012'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';
  SELECT e INTO v_daily
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000012'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'daily';

  IF v_total->'self' <> jsonb_build_object('value', 4, 'rank', 12, 'percentile', 15) THEN
    RAISE EXCEPTION '手動ドローが累計に混入している: %', v_total->'self';
  END IF;
  IF v_daily->'self' <> 'null'::jsonb THEN
    RAISE EXCEPTION '手動ドローが日次に混入している: %', v_daily->'self';
  END IF;
END $$;

-- insufficientData（daily は参加者 2 人）: top/neighbors は空、順位も出さないが値は返す
DO $$
DECLARE
  v_entry jsonb;
BEGIN
  SELECT e INTO v_entry
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000001'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'daily';

  IF (v_entry->>'participantCount')::int <> 2 THEN
    RAISE EXCEPTION 'daily の participantCount が 2 でない: %', v_entry->>'participantCount';
  END IF;
  IF NOT (v_entry->>'insufficientData')::boolean THEN
    RAISE EXCEPTION 'daily が insufficientData=false（参加者 2 では true のはず）';
  END IF;
  IF jsonb_array_length(v_entry->'top') <> 0 OR jsonb_array_length(v_entry->'neighbors') <> 0 THEN
    RAISE EXCEPTION 'insufficientData なのに top/neighbors が空でない: %', v_entry;
  END IF;
  IF v_entry->'self' <> jsonb_build_object('value', 10, 'rank', NULL, 'percentile', NULL) THEN
    RAISE EXCEPTION 'insufficientData の self が想定と不一致: %', v_entry->'self';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. 匿名性: 応答 JSON に他チャンネルの識別子が一切現れない
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_text text;
  v_self uuid;
  v_leak record;
BEGIN
  FOR v_self IN
    SELECT ('74000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
    FROM generate_series(1, 14) AS i
  LOOP
    v_text := public.get_streamer_ranking(v_self)::text;

    -- UUID 形式の文字列が応答のどこにも現れない（streamer_id を絶対に含めない）
    IF v_text ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' THEN
      RAISE EXCEPTION '応答 JSON に UUID 形式の文字列が含まれる: %', v_text;
    END IF;

    -- 識別子らしきキーを持たない
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(public.get_streamer_ranking(v_self)->'rankings') e,
                    LATERAL jsonb_object_keys(e) k
      WHERE k IN ('streamer_id', 'streamerId', 'username', 'displayName', 'twitch_username')
    ) THEN
      RAISE EXCEPTION '応答に識別子キーが存在する';
    END IF;

    -- 他チャンネルの username / display_name が文字列として現れない
    SELECT s.twitch_user_id, s.twitch_username, s.twitch_display_name
      INTO v_leak
    FROM public.streamers s
    WHERE s.id <> v_self
      AND (
        position(s.twitch_username IN v_text) > 0
        OR position(s.twitch_display_name IN v_text) > 0
        OR position(s.twitch_user_id IN v_text) > 0
      )
    LIMIT 1;
    IF v_leak IS NOT NULL THEN
      RAISE EXCEPTION '他の配信者の識別子が漏れている: %', v_leak;
    END IF;

    -- 自分の識別子も応答には含まれない（値と順位のみで表現する contract）
    IF position((SELECT twitch_username FROM public.streamers WHERE id = v_self) IN v_text) > 0 THEN
      RAISE EXCEPTION '自分自身の username が応答に含まれている: %', v_self;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. insufficientData 境界（participant_count 4 と 5）
-- ---------------------------------------------------------------------------

-- snapshot を合成値で置き換え、参加者 4 人 -> 5 人の境界を直接検証する。
DELETE FROM public.streamer_ranking_snapshots;

INSERT INTO public.streamer_ranking_snapshots
  (metric, period, streamer_id, rank, position, value, participant_count, computed_at)
SELECT
  'draws', 'total',
  ('74000000-0000-4000-8000-' || lpad(p.idx::text, 12, '0'))::uuid,
  p.rank, p.position, p.value, p.participant_count,
  '2026-01-01 00:00:00+00'::timestamptz
FROM (VALUES
  (1, 1, 1, 40::bigint, 4),
  (2, 2, 2, 30, 4),
  (3, 3, 3, 20, 4),
  (4, 4, 4, 10, 4)
) AS p(idx, rank, position, value, participant_count);

DO $$
DECLARE
  v_entry jsonb;
BEGIN
  SELECT e INTO v_entry
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000004'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';

  IF (v_entry->>'participantCount')::int <> 4 OR NOT (v_entry->>'insufficientData')::boolean THEN
    RAISE EXCEPTION '参加者 4 人は insufficientData=true のはず: %', v_entry;
  END IF;
  IF jsonb_array_length(v_entry->'top') <> 0 OR jsonb_array_length(v_entry->'neighbors') <> 0 THEN
    RAISE EXCEPTION '参加者 4 人で top/neighbors が空でない: %', v_entry;
  END IF;
  IF v_entry->'self' <> jsonb_build_object('value', 10, 'rank', NULL, 'percentile', NULL) THEN
    RAISE EXCEPTION '参加者 4 人の self が想定と不一致: %', v_entry->'self';
  END IF;
END $$;

UPDATE public.streamer_ranking_snapshots SET participant_count = 5;

INSERT INTO public.streamer_ranking_snapshots
  (metric, period, streamer_id, rank, position, value, participant_count, computed_at)
VALUES
  ('draws', 'total', '74000000-0000-4000-8000-000000000005'::uuid, 5, 5, 5, 5,
   '2026-01-01 00:00:00+00'::timestamptz);

DO $$
DECLARE
  v_entry jsonb;
BEGIN
  SELECT e INTO v_entry
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000004'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';

  IF (v_entry->>'participantCount')::int <> 5 OR (v_entry->>'insufficientData')::boolean THEN
    RAISE EXCEPTION '参加者 5 人は insufficientData=false のはず: %', v_entry;
  END IF;
  IF jsonb_array_length(v_entry->'top') <> 5 THEN
    RAISE EXCEPTION '参加者 5 人で top が 5 行でない: %', v_entry->'top';
  END IF;
  IF v_entry->'self' <> jsonb_build_object('value', 10, 'rank', 4, 'percentile', 40) THEN
    RAISE EXCEPTION '参加者 5 人の self が想定と不一致: %', v_entry->'self';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5b. 同値 rank の透過と、位置（position）ベースの近傍選択
-- ---------------------------------------------------------------------------
-- 子A の snapshot は「表示用の rank（RANK()、同値同順位）」と「一意な position
-- （ROW_NUMBER()）」を別列で持つ。本関数は表示に rank をそのまま使い、top/neighbors の
-- 選択には position を使う。この分離を合成 snapshot で直接検証する（同値 RANK の
-- 定義そのものは子A 側 PR #1775 で修正中のため、実集計結果ではなく合成行で固定する）。
DELETE FROM public.streamer_ranking_snapshots;

INSERT INTO public.streamer_ranking_snapshots
  (metric, period, streamer_id, rank, position, value, participant_count, computed_at)
SELECT
  'draws', 'total',
  ('74000000-0000-4000-8000-' || lpad(p.idx::text, 12, '0'))::uuid,
  p.rank, p.position, p.value, 12,
  '2026-01-02 00:00:00+00'::timestamptz
FROM (VALUES
  (1, 1, 1, 60::bigint), (2, 2, 2, 50), (3, 2, 3, 50), (4, 4, 4, 40),
  (5, 5, 5, 30), (6, 6, 6, 20), (7, 7, 7, 10), (8, 7, 8, 10), (9, 7, 9, 10),
  (10, 10, 10, 5), (11, 11, 11, 4), (12, 12, 12, 3)
) AS p(idx, rank, position, value);

DO $$
DECLARE
  v_entry jsonb;
BEGIN
  SELECT e INTO v_entry
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000012'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';

  IF (v_entry->>'participantCount')::int <> 12 OR (v_entry->>'insufficientData')::boolean THEN
    RAISE EXCEPTION '合成 snapshot の participantCount/insufficientData が想定と不一致: %', v_entry;
  END IF;

  -- top は position 1〜10。rank は同値同順位のまま透過される
  -- （50 が 2 人、10 が 3 人なので順位は 1,2,2,4,…,7,7,7,10）
  IF (SELECT array_agg((t.r->>'rank')::int ORDER BY t.ord)
        FROM jsonb_array_elements(v_entry->'top') WITH ORDINALITY AS t(r, ord))
     <> ARRAY[1, 2, 2, 4, 5, 6, 7, 7, 7, 10] THEN
    RAISE EXCEPTION '同値 rank が表示順位として透過されていない: %', v_entry->'top';
  END IF;
  IF (SELECT array_agg((t.r->>'value')::bigint ORDER BY t.ord)
        FROM jsonb_array_elements(v_entry->'top') WITH ORDINALITY AS t(r, ord))
     <> ARRAY[60, 50, 50, 40, 30, 20, 10, 10, 10, 5]::bigint[] THEN
    RAISE EXCEPTION '同値時の top 並びが想定と不一致: %', v_entry->'top';
  END IF;

  -- neighbors は self の position 12 の ±2 から top（position <= 10）を除いた 11〜12
  IF (SELECT array_agg((t.r->>'rank')::int ORDER BY t.ord)
        FROM jsonb_array_elements(v_entry->'neighbors') WITH ORDINALITY AS t(r, ord))
     <> ARRAY[11, 12] THEN
    RAISE EXCEPTION 'neighbors が position 基準で選択されていない: %', v_entry->'neighbors';
  END IF;
  IF (SELECT array_agg((t.r->>'value')::bigint ORDER BY t.ord)
        FROM jsonb_array_elements(v_entry->'neighbors') WITH ORDINALITY AS t(r, ord))
     <> ARRAY[4, 3]::bigint[] THEN
    RAISE EXCEPTION 'neighbors の並びが想定と不一致: %', v_entry->'neighbors';
  END IF;
  IF (v_entry->'neighbors'->1->>'isSelf')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'neighbors 内の self 位置が想定と不一致: %', v_entry->'neighbors';
  END IF;

  IF v_entry->'self' <> jsonb_build_object('value', 3, 'rank', 12, 'percentile', 8) THEN
    RAISE EXCEPTION '同値 rank 下の self が想定と不一致: %', v_entry->'self';
  END IF;
END $$;

-- percentile は「一意な position」ではなく「表示 rank」から導出する
-- （同値の 2 人が別々の百分位にならないようにするため）。
-- idx 3 は value 50 / rank 2 / position 3 なので、rank 基準なら 92、position 基準なら 83 になる。
DO $$
DECLARE
  v_entry jsonb;
BEGIN
  SELECT e INTO v_entry
  FROM jsonb_array_elements(
         public.get_streamer_ranking('74000000-0000-4000-8000-000000000003'::uuid)->'rankings'
       ) e
  WHERE e->>'metric' = 'draws' AND e->>'period' = 'total';

  IF v_entry->'self' <> jsonb_build_object('value', 50, 'rank', 2, 'percentile', 92) THEN
    RAISE EXCEPTION 'percentile が position 基準になっている（rank 基準であるべき）: %', v_entry->'self';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. snapshot 0 行（backfill 前）: computedAt=null + 全エントリ insufficientData
-- ---------------------------------------------------------------------------

DELETE FROM public.streamer_ranking_snapshots;

DO $$
DECLARE
  v_payload jsonb;
BEGIN
  v_payload := public.get_streamer_ranking('74000000-0000-4000-8000-000000000001'::uuid);

  IF v_payload->'computedAt' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'snapshot 0 行で computedAt が null でない: %', v_payload->'computedAt';
  END IF;
  IF jsonb_array_length(v_payload->'rankings') <> 4 THEN
    RAISE EXCEPTION 'snapshot 0 行でも 4 エントリ返すはず: %', v_payload;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payload->'rankings') e
    WHERE NOT (e->>'insufficientData')::boolean
       OR (e->>'participantCount')::int <> 0
       OR jsonb_array_length(e->'top') <> 0
       OR jsonb_array_length(e->'neighbors') <> 0
  ) THEN
    RAISE EXCEPTION 'snapshot 0 行の応答が contract と不一致: %', v_payload;
  END IF;

  -- 未知の streamer_id でも例外にせず自分の値 0 を返す
  IF (SELECT count(*) FROM jsonb_array_elements(
        public.get_streamer_ranking('00000000-0000-4000-8000-00000000dead'::uuid)->'rankings')) <> 4 THEN
    RAISE EXCEPTION '未知の streamer_id で 4 エントリが返らない';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. 権限: anon / authenticated は実行不可、service_role は実行可（生 snapshot も不可）
-- ---------------------------------------------------------------------------

SET LOCAL ROLE anon;

DO $$
BEGIN
  PERFORM public.get_streamer_ranking('74000000-0000-4000-8000-000000000001'::uuid);
  RAISE EXCEPTION 'anon が get_streamer_ranking を実行できてしまった';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL; -- 期待どおり
END $$;

DO $$
BEGIN
  PERFORM count(*) FROM public.streamer_ranking_snapshots;
  RAISE EXCEPTION 'anon が生 snapshot を読めてしまった';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL; -- 期待どおり
END $$;

RESET ROLE;

SET LOCAL ROLE authenticated;

DO $$
BEGIN
  PERFORM public.get_streamer_ranking('74000000-0000-4000-8000-000000000001'::uuid);
  RAISE EXCEPTION 'authenticated が get_streamer_ranking を実行できてしまった';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL; -- 期待どおり
END $$;

RESET ROLE;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_payload jsonb;
BEGIN
  v_payload := public.get_streamer_ranking('74000000-0000-4000-8000-000000000001'::uuid);
  IF jsonb_array_length(v_payload->'rankings') <> 4 THEN
    RAISE EXCEPTION 'service_role が get_streamer_ranking を実行できない';
  END IF;
END $$;

RESET ROLE;

ROLLBACK;
