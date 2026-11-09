-- migration-transaction: required
-- migration-providers: planetscale
--
-- Issue #742 (子B): 匿名ランキング取得関数 get_streamer_ranking(p_streamer_id)。
--
-- 子A (PR #1764 / migration 20261007120000_streamer_stats_aggregation.sql) が
-- streamer_ranking_snapshots を毎時バッチで原子的に置換するところまで実装済み。
-- 本 migration はそのスナップショットを配信者ダッシュボードへ公開する読み取り経路
-- (Issue #742) の DB 側を追加する。
--
-- 2026-09-24 の Issue #742 再ベースラインに従い、旧本文の前提は使わない:
--   - PostgREST / service_role クライアントの `.rpc()` / dual-driver parity は
--     実装しない (現行は PlanetScale PostgreSQL 固定の単一 runtime)。
--     呼び出しは内部 API から postgres.js + Drizzle 経由の
--     `select public.get_streamer_ranking($1)` の1文のみ。
--   - SECURITY DEFINER は付けない (子Aと同じ判断。呼び出しロール twica_app は
--     service_role のメンバー + BYPASSRLS でフルアクセスを持つため、定義者権限へ
--     エスカレートする必要がない)。公開範囲の制御は
--     `REVOKE ALL ... FROM PUBLIC, anon, authenticated` +
--     `GRANT EXECUTE ... TO service_role` のみで行う。
--   - RLS ポリシーも追加しない (同上)。
--
-- 維持する不変条件 (旧本文の安全要件):
--   1. 匿名化はこの関数の応答生成時点で完結する。返す JSON は rank / value /
--      isSelf だけで構成し、他チャンネルの streamer_id・名前・アイコン等の
--      識別子はフィールド自体を持たない (呼び出し元アプリ層へ一切渡さない)。
--      そのため生 snapshot テーブルは anon / authenticated へ公開しないまま
--      (子Aの REVOKE 済み) でよい。
--   2. 単一の SQL statement で全ての行を取る。READ COMMITTED では関数本体内の
--      逐次 SELECT が文ごとに新しいスナップショットを取るため、バッチの
--      DELETE→INSERT コミットを跨ぐと self と top が別世代になりうる。
--      LANGUAGE sql の1文 (WITH ... SELECT) に束ねることで、文単位スナップショットで
--      self / top / neighbors / computedAt を一括取得し、世代一貫性を保証する。
--   3. self が母集団外 (直近30日に排出なし) の場合だけ、自分の累計値
--      (draws/total は streamer_daily_stats の SUM、card_count/current は
--      cards の COUNT) を自分自身の行からのみ補完する。他チャンネルの行には
--      一切触れないため、匿名性にも負荷にも影響しない。
--
-- レスポンス contract (Issue #742):
--   {
--     "schemaVersion": 1,
--     "computedAt": "2026-10-07T11:00:00.000Z" | null,
--     "rankings": [
--       { "metric": "draws"|"card_count",
--         "period": "total"|"weekly"|"daily"|"current",
--         "participantCount": number,
--         "insufficientData": boolean,
--         "self": { "value": number, "rank": number|null,
--                   "percentile": number|null } | null,
--         "top": [{ "rank": number, "value": number, "isSelf": boolean }],
--         "neighbors": [ ... 同上 ... ] },
--       ... 4 エントリ ...
--     ]
--   }
--
-- 設計判断 (上位仕様が定めていない箇所の明示。UI/子C はこの定義に従う):
--   - rankings の順序は draws/total, draws/weekly, draws/daily,
--     card_count/current の固定順 (ord)。UI が順序に依存できるようにする。
--   - percentile は rank 基準の「自分より上位でない参加者の割合」:
--     round(100 * (participant_count - rank + 1) / participant_count)。
--     1位 = 100、最下位 = 100/n で、0 にはならない。同値同順位 (RANK) の
--     チャンネルは同じ百分位を表示する。
--   - insufficientData は participant_count < 5。参加者が4人以下では
--     匿名性が実質的に壊れる (1位と最下位が特定できる) ため、順位・近傍を
--     一切返さず self の値だけを返す。
--   - top は position <= 10 の行 (上位10チャンネル)。neighbors は
--     self の position ± 2 から top に含まれる行 (position <= 10) を除いた行で、
--     self が top 圏内なら空。position は ROW_NUMBER で一意なため重複しない。
--   - neighbors には self 自身の行が含まれうる (isSelf=true)。UI が自分の
--     位置を近傍リスト内で強調できるようにするため。
--   - card_count/current の value は cards の全行数 (非アクティブ含む) で、
--     子A の snapshot 生成と同じ定義。表示可否 (product 判断) は本関数では
--     決めない — 認可済み配信者自身にしか返さず、他チャンネルの識別子は返さない。
--
-- 加法性: CREATE OR REPLACE FUNCTION + REVOKE / GRANT のみ。

CREATE OR REPLACE FUNCTION public.get_streamer_ranking(p_streamer_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH combos (metric, period, ord) AS (
    VALUES
      ('draws'::text, 'total'::text, 1),
      ('draws'::text, 'weekly'::text, 2),
      ('draws'::text, 'daily'::text, 3),
      ('card_count'::text, 'current'::text, 4)
  ),
  -- snap は複数箇所から参照されるため PostgreSQL が materialize する
  -- (1文の中で1回だけスキャンし、全参照が同じスナップショットを見る)。
  snap AS (
    SELECT
      s.metric,
      s.period,
      s.streamer_id,
      s.rank,
      s.position,
      s.value,
      s.participant_count,
      s.computed_at
    FROM public.streamer_ranking_snapshots s
  ),
  combo_state AS (
    SELECT
      c.metric,
      c.period,
      c.ord,
      -- participant_count は同一 metric/period の全行で同じ値。self が母集団外でも
      -- 他チャンネルの行から取れる (行が1つも無ければ 0 = backfill 前)。
      COALESCE(m.participant_count, 0)::integer AS participant_count,
      m.self_position,
      m.self_rank,
      -- self の値: snapshot にあればそれを正とする。無い場合 (= 母集団外) だけ
      -- 自分の行から補完する。daily/weekly は母集団外なら必ず 0 回なので
      -- 補完せず null のまま (= self: null) とする。
      CASE
        WHEN m.self_value IS NOT NULL THEN m.self_value
        WHEN c.metric = 'draws' AND c.period = 'total' THEN fb.draws_total
        WHEN c.metric = 'card_count' AND c.period = 'current' THEN fb.card_current
        ELSE NULL
      END AS self_value
    FROM combos c
    LEFT JOIN LATERAL (
      SELECT
        max(s.participant_count)::integer AS participant_count,
        max(s.position) FILTER (WHERE s.streamer_id = p_streamer_id) AS self_position,
        max(s.rank) FILTER (WHERE s.streamer_id = p_streamer_id) AS self_rank,
        max(s.value) FILTER (WHERE s.streamer_id = p_streamer_id) AS self_value
      FROM snap s
      WHERE s.metric = c.metric
        AND s.period = c.period
    ) m ON TRUE
    -- self フォールバック用の自分の集計値。draws/total は PK 先頭 streamer_id の
    -- index scan (streamer_daily_stats PK)、card_count は cards(streamer_id) の
    -- index scan で、いずれも自分の行だけを読む。
    CROSS JOIN LATERAL (
      SELECT
        (
          SELECT COALESCE(sum(d.draw_count), 0)::bigint
          FROM public.streamer_daily_stats d
          WHERE d.streamer_id = p_streamer_id
        ) AS draws_total,
        (
          SELECT count(*)::bigint
          FROM public.cards c
          WHERE c.streamer_id = p_streamer_id
        ) AS card_current
    ) fb
  ),
  entries AS (
    SELECT
      cs.ord,
      jsonb_build_object(
        'metric', cs.metric,
        'period', cs.period,
        'participantCount', cs.participant_count,
        'insufficientData', cs.participant_count < 5,
        'self', CASE
          WHEN cs.self_value IS NULL THEN NULL
          ELSE jsonb_build_object(
            'value', cs.self_value,
            -- 参加者4人以下では順位を出さない (匿名性のため)。
            'rank', CASE
              WHEN cs.participant_count >= 5 THEN cs.self_rank
              ELSE NULL
            END,
            'percentile', CASE
              WHEN cs.participant_count >= 5 AND cs.self_rank IS NOT NULL
                THEN round(
                  100.0 * (cs.participant_count - cs.self_rank + 1)
                  / cs.participant_count
                )::integer
              ELSE NULL
            END
          )
        END,
        'top', CASE
          WHEN cs.participant_count < 5 THEN '[]'::jsonb
          ELSE COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'rank', t.rank,
                  'value', t.value,
                  'isSelf', t.streamer_id = p_streamer_id
                )
                ORDER BY t.position
              )
              FROM snap t
              WHERE t.metric = cs.metric
                AND t.period = cs.period
                AND t.position <= 10
            ),
            '[]'::jsonb
          )
        END,
        'neighbors', CASE
          WHEN cs.participant_count < 5
            OR cs.self_position IS NULL
            OR cs.self_position <= 10
            THEN '[]'::jsonb
          ELSE COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'rank', n.rank,
                  'value', n.value,
                  'isSelf', n.streamer_id = p_streamer_id
                )
                ORDER BY n.position
              )
              FROM snap n
              WHERE n.metric = cs.metric
                AND n.period = cs.period
                AND n.position BETWEEN cs.self_position - 2 AND cs.self_position + 2
                AND n.position > 10
            ),
            '[]'::jsonb
          )
        END
      ) AS entry
    FROM combo_state cs
  )
  SELECT jsonb_build_object(
    'schemaVersion', 1,
    -- セッション TimeZone に依存しない固定形式 (UTC, ISO 8601) にする。snapshot が
    -- 0 行の間 (backfill 前) は null。
    'computedAt', (
      SELECT to_char(
        max(s.computed_at) AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
      FROM snap s
    ),
    'rankings', COALESCE(jsonb_agg(e.entry ORDER BY e.ord), '[]'::jsonb)
  )
  FROM entries e;
$$;

REVOKE ALL ON FUNCTION public.get_streamer_ranking(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_streamer_ranking(uuid) TO service_role;

COMMENT ON FUNCTION public.get_streamer_ranking(uuid) IS
  '配信者本人の匿名ランキング取得 (Issue #742)。他チャンネルの識別子を含まない
  匿名化済み JSON を1文で構築して返す。世代一貫性のため self/top/neighbors は
  同一 statement で取得する。anon/authenticated は実行不可 (service_role のみ)。';
