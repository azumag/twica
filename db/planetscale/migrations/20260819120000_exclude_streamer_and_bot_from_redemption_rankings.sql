-- migration-transaction: required
-- migration-providers: planetscale
--
-- Issue: 引き換えランキングから「配信者本人」「登録済みチャット通知BOTアカウント」を
-- 除外し、N連ガチャを N 回として数える。
--
-- 【問題1】除外がない
--   gacha_history.user_twitch_id には配信者本人（自チャンネルのQAテスト引き換え、
--   POST /api/gacha の手動ドロー）や BOT アカウントが混ざるため、視聴者向け
--   ランキングとして意味を成していない。
--
-- 【問題2】N連が1回になる
--   executeGachaDraws (src/lib/services/gacha.ts) は reward_cost を index===0 の
--   行にだけ載せる（Twitch EventSub が「引き換え1回あたりの合計コスト」しか通知
--   しないため、二重計上を避ける意図的な設計）。一方 reward_id は全行へ forward
--   される。従来条件 `reward_cost IS NOT NULL AND reward_cost > 0` は2枚目以降を
--   落とすため COUNT(*) が常に 1 になっていた。
--
-- 【新しい述語】 (reward_cost > 0 OR reward_id IS NOT NULL)
--   - reward_id が導入されたのは 00070_add_gacha_history_reward_id.sql（2026-07-04）で、
--     それ以前の行は reward_cost のみを持つ（reward_id は既存レコードNULL、と同migration
--     のCOMMENT ON COLUMNに明記）。`reward_id IS NOT NULL` 単独に置き換えると
--     2026-04〜07 の正当な引き換えが全部消えるため、OR で両方を受ける。
--   - SUM(reward_cost) は NULL を無視するのでポイント合計値は不変。
--   - レイドガチャ (executeGachaForRaidEvent) と手動QAドロー
--     (src/app/api/gacha/route.ts の manual:<uuid>) は両方 NULL なので従来どおり除外。
--   - 既知の限界: 2026-07-04 以前の N連2枚目以降は復元できない。全経路で同一述語に
--     揃えることを優先し、バックフィルだけ別条件にする非決定性は避ける。

SET LOCAL statement_timeout = 0;

-- ---------------------------------------------------------------------------
-- 1) 除外判定の唯一の正本（新規関数）
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER も SET search_path も付けない: 呼び出し元(refresh_channel_point_
-- usage_stat 等)が既にその文脈で実行されるため不要であり、付けるとSQL関数の
-- インライン展開が無効化されるため（LANGUAGE sql関数はプランナがインライン化
-- できて初めてインデックスを使った実行計画になる）。
CREATE OR REPLACE FUNCTION public.is_redemption_ranking_excluded(
  p_streamer_id uuid,
  p_user_twitch_id text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.streamers s
      WHERE s.id = p_streamer_id
        AND s.twitch_user_id = p_user_twitch_id
    )
    OR EXISTS (
      SELECT 1 FROM public.twitch_bot_accounts b
      WHERE b.owner_type = 'streamer'
        AND b.streamer_id = p_streamer_id
        AND b.twitch_user_id = p_user_twitch_id
    )
    OR EXISTS (
      SELECT 1 FROM public.twitch_bot_accounts b
      WHERE b.owner_type = 'system'
        AND b.twitch_user_id = p_user_twitch_id
    );
$$;

COMMENT ON FUNCTION public.is_redemption_ranking_excluded(uuid, text) IS
  '引き換えランキング集計から除外するアカウント判定（配信者本人 / 登録済みBOT / 共有BOT）。status は問わない（revoked でも過去のBOT行為であることに変わりはない）';

REVOKE ALL ON FUNCTION public.is_redemption_ranking_excluded(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_redemption_ranking_excluded(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2) 累積テーブル更新トリガー本体（既存関数の CREATE OR REPLACE）
-- ---------------------------------------------------------------------------
-- 20260719180100_planetscale_public_schema_baseline.sql の定義を丸ごとコピーし、
-- (a) 除外対象は早期DELETE+RETURNする、(b) N連2枚目以降を拾う新述語にする、の
-- 2点だけを変更した。関数シグネチャ・SECURITY DEFINER・SET search_path・
-- 後半のINSERT...ON CONFLICTは無変更。
CREATE OR REPLACE FUNCTION public.refresh_channel_point_usage_stat(p_streamer_id uuid, p_user_twitch_id text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_username TEXT;
  v_total_points BIGINT;
  v_redemption_count INTEGER;
  v_last_redeemed_at TIMESTAMPTZ;
BEGIN
  IF p_streamer_id IS NULL OR p_user_twitch_id IS NULL THEN
    RETURN;
  END IF;

  -- 除外対象は集計せず、既存行があれば取り除く。
  -- これにより「除外対象が引き換えると、その行が消える」という自己修復が働く。
  IF is_redemption_ranking_excluded(p_streamer_id, p_user_twitch_id) THEN
    DELETE FROM channel_point_usage_stats
    WHERE streamer_id = p_streamer_id
      AND user_twitch_id = p_user_twitch_id;
    RETURN;
  END IF;

  SELECT
    COALESCE(MAX(user_twitch_username), p_user_twitch_id),
    COALESCE(SUM(reward_cost), 0)::BIGINT,
    COUNT(*)::INTEGER,
    MAX(redeemed_at)
  INTO
    v_username,
    v_total_points,
    v_redemption_count,
    v_last_redeemed_at
  FROM gacha_history
  WHERE streamer_id = p_streamer_id
    AND user_twitch_id = p_user_twitch_id
    -- N連の2枚目以降(reward_cost IS NULL / reward_id 非NULL)も1回として数える
    AND (reward_cost > 0 OR reward_id IS NOT NULL);

  IF v_redemption_count = 0 THEN
    DELETE FROM channel_point_usage_stats
    WHERE streamer_id = p_streamer_id
      AND user_twitch_id = p_user_twitch_id;
    RETURN;
  END IF;

  INSERT INTO channel_point_usage_stats (
    streamer_id,
    user_twitch_id,
    username,
    total_points,
    redemption_count,
    last_redeemed_at
  )
  VALUES (
    p_streamer_id,
    p_user_twitch_id,
    v_username,
    v_total_points,
    v_redemption_count,
    v_last_redeemed_at
  )
  ON CONFLICT (streamer_id, user_twitch_id) DO UPDATE SET
    username = EXCLUDED.username,
    total_points = EXCLUDED.total_points,
    redemption_count = EXCLUDED.redemption_count,
    last_redeemed_at = EXCLUDED.last_redeemed_at,
    updated_at = NOW();
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) BOTアカウント登録・差し替え時の再集計トリガー（新規）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_channel_point_usage_stat_for_bot_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 旧アカウント(UPDATE前 or DELETE済み)は除外対象から外れるので、履歴から
  -- 復帰させる。BOT連携解除は twitch_bot_accounts 行を物理DELETEする実経路
  -- (src/app/api/streamer/settings/route.ts の disconnectBotAccountPg)のため、
  -- UPDATEだけでなくDELETEも拾わないと、解除後もランキングが永久に復帰しない。
  -- DELETEではNEWが存在しないため、この分岐はUPDATE/DELETEに限定する。
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM refresh_channel_point_usage_stat(s.id, OLD.twitch_user_id)
    FROM streamers s
    WHERE OLD.owner_type = 'system' OR s.id = OLD.streamer_id;
  END IF;

  -- 新アカウント(INSERT or UPDATE後)は除外対象になるので、既存行を取り除く。
  -- DELETEではNEWが存在しないため、この分岐はINSERT/UPDATEに限定する。
  -- FROM streamers を経由するのは、owner_type='system'(streamer_id NULL)の
  -- ときに全配信者へrefreshを展開するため（streamer固有なら該当1配信者のみ）。
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM refresh_channel_point_usage_stat(s.id, NEW.twitch_user_id)
    FROM streamers s
    WHERE NEW.owner_type = 'system' OR s.id = NEW.streamer_id;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_channel_point_usage_stat_bot_account
  ON public.twitch_bot_accounts;

-- UPDATE OF で列を限定するのは必須。無指定にすると OAuth トークンリフレッシュ
-- （twitch_access_token / twitch_refresh_lease_id の更新）のたびに発火する
-- (OF は UPDATE 句にのみ掛かり、INSERT/DELETEの発火条件には影響しない)。
-- DELETE も対象に含める: BOT連携解除(disconnectBotAccountPg)は行を物理DELETE
-- するため、DELETEを拾わないと除外解除後もランキングが復帰しない。
CREATE TRIGGER trg_sync_channel_point_usage_stat_bot_account
AFTER INSERT OR DELETE OR UPDATE OF twitch_user_id, streamer_id, owner_type
ON public.twitch_bot_accounts
FOR EACH ROW
EXECUTE FUNCTION public.sync_channel_point_usage_stat_for_bot_account();

-- ---------------------------------------------------------------------------
-- 4) 配信者ダッシュボード用RPC（既存関数の CREATE OR REPLACE）
-- ---------------------------------------------------------------------------
-- 20260719180100_planetscale_public_schema_baseline.sql の定義を丸ごとコピーし、
-- ELSE分岐（gacha_historyを直接集計する部分）だけ新述語+除外判定に置き換えた。
-- p_from_date IS NULL 分岐（channel_point_usage_statsを読むだけの部分。累積
-- テーブル自体がrefresh_channel_point_usage_statで既に除外済みのため無変更）と
-- 関数シグネチャは無変更。
CREATE OR REPLACE FUNCTION public.get_channel_point_usage_stats(p_streamer_id uuid, p_from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 10) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_total_points BIGINT;
  v_ranking JSONB;
BEGIN
  IF p_from_date IS NULL THEN
    SELECT COALESCE(SUM(total_points), 0)::BIGINT
    INTO v_total_points
    FROM channel_point_usage_stats
    WHERE streamer_id = p_streamer_id;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_twitch_id', ranked.user_twitch_id,
        'username', ranked.username,
        'total_points', ranked.total_points,
        'redemption_count', ranked.redemption_count,
        'last_redeemed_at', ranked.last_redeemed_at
      )
      ORDER BY ranked.total_points DESC, ranked.redemption_count DESC, ranked.last_redeemed_at DESC
    ), '[]'::JSONB)
    INTO v_ranking
    FROM (
      SELECT
        user_twitch_id,
        COALESCE(username, user_twitch_id) AS username,
        total_points,
        redemption_count,
        last_redeemed_at::TEXT AS last_redeemed_at
      FROM channel_point_usage_stats
      WHERE streamer_id = p_streamer_id
      ORDER BY total_points DESC, redemption_count DESC, last_redeemed_at DESC
      LIMIT GREATEST(1, p_limit)
    ) ranked;
  ELSE
    SELECT COALESCE(SUM(per_user.total_points), 0)::BIGINT
    INTO v_total_points
    FROM (
      SELECT
        user_twitch_id,
        SUM(reward_cost) AS total_points
      FROM gacha_history
      WHERE streamer_id = p_streamer_id
        AND redeemed_at >= p_from_date
        AND (reward_cost > 0 OR reward_id IS NOT NULL)
      GROUP BY user_twitch_id
    ) per_user
    WHERE NOT is_redemption_ranking_excluded(p_streamer_id, per_user.user_twitch_id);

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_twitch_id', ranked.user_twitch_id,
        'username', ranked.username,
        'total_points', ranked.total_points,
        'redemption_count', ranked.redemption_count,
        'last_redeemed_at', ranked.last_redeemed_at
      )
      ORDER BY ranked.total_points DESC, ranked.redemption_count DESC, ranked.last_redeemed_at DESC
    ), '[]'::JSONB)
    INTO v_ranking
    FROM (
      SELECT
        user_twitch_id,
        COALESCE(MAX(user_twitch_username), user_twitch_id) AS username,
        COALESCE(SUM(reward_cost), 0)::BIGINT AS total_points,
        COUNT(*)::INTEGER AS redemption_count,
        MAX(redeemed_at)::TEXT AS last_redeemed_at
      FROM gacha_history
      WHERE streamer_id = p_streamer_id
        AND redeemed_at >= p_from_date
        AND (reward_cost > 0 OR reward_id IS NOT NULL)
      GROUP BY user_twitch_id
      HAVING NOT is_redemption_ranking_excluded(p_streamer_id, user_twitch_id)
      ORDER BY total_points DESC, redemption_count DESC, last_redeemed_at DESC
      LIMIT GREATEST(1, p_limit)
    ) ranked;
  END IF;

  RETURN jsonb_build_object(
    'total_points', v_total_points,
    'ranking', v_ranking
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) /live 配信者間ランキング（既存関数の CREATE OR REPLACE）
-- ---------------------------------------------------------------------------
-- 20260811130000_add_live_directory_ranking_periods.sql の定義を全文コピーし、
-- last_7_days_usage CTEだけを新述語+除外判定に置き換えた。他のCTE
-- （parameters, card_counts, all_time_usage, aggregated, periodized, ranked,
-- selected, period_catalog, period_payloads）と最終SELECTは無変更（匿名化
-- ロジック・ROW_NUMBER・ORDER BYは変更しない）。
CREATE OR REPLACE FUNCTION get_live_directory_rankings_by_period()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH parameters AS (
  SELECT CURRENT_TIMESTAMP - INTERVAL '7 days' AS last_7_days_start
),
card_counts AS (
  SELECT
    c.streamer_id,
    COUNT(*) FILTER (WHERE c.is_active = TRUE)::INTEGER AS all_time_card_count,
    COUNT(*) FILTER (
      WHERE c.is_active = TRUE
        AND c.created_at >= parameters.last_7_days_start
    )::INTEGER AS last_7_days_card_count
  FROM cards c
  CROSS JOIN parameters
  GROUP BY c.streamer_id
),
all_time_usage AS (
  SELECT
    usage.streamer_id,
    COALESCE(SUM(usage.redemption_count), 0)::BIGINT AS redemption_count,
    COALESCE(SUM(usage.total_points), 0)::BIGINT AS total_points
  FROM channel_point_usage_stats usage
  GROUP BY usage.streamer_id
),
last_7_days_usage AS (
  -- 2段GROUP BY。1段目でユーザー単位に畳んでから除外判定するため、
  -- is_redemption_ranking_excluded の呼び出し回数は「7日間にアクティブだった
  -- (配信者, 視聴者) ペア数」に抑えられる（履歴行数ではない）。
  SELECT
    per_user.streamer_id,
    SUM(per_user.redemption_count)::BIGINT AS redemption_count,
    SUM(per_user.total_points)::BIGINT AS total_points
  FROM (
    SELECT
      history.streamer_id,
      history.user_twitch_id,
      COUNT(*)::BIGINT AS redemption_count,
      COALESCE(SUM(history.reward_cost), 0)::BIGINT AS total_points
    FROM gacha_history history
    CROSS JOIN parameters
    WHERE (history.reward_cost > 0 OR history.reward_id IS NOT NULL)
      AND history.redeemed_at >= parameters.last_7_days_start
    GROUP BY history.streamer_id, history.user_twitch_id
  ) per_user
  WHERE NOT is_redemption_ranking_excluded(per_user.streamer_id, per_user.user_twitch_id)
  GROUP BY per_user.streamer_id
),
aggregated AS (
  SELECT
    streamer.publish_stats,
    streamer.twitch_username,
    streamer.twitch_display_name,
    streamer.twitch_profile_image_url,
    COALESCE(cards.all_time_card_count, 0) AS all_time_card_count,
    COALESCE(cards.last_7_days_card_count, 0) AS last_7_days_card_count,
    COALESCE(all_usage.redemption_count, 0) AS all_time_redemption_count,
    COALESCE(all_usage.total_points, 0) AS all_time_total_points,
    COALESCE(recent_usage.redemption_count, 0) AS last_7_days_redemption_count,
    COALESCE(recent_usage.total_points, 0) AS last_7_days_total_points
  FROM streamers streamer
  LEFT JOIN card_counts cards ON cards.streamer_id = streamer.id
  LEFT JOIN all_time_usage all_usage ON all_usage.streamer_id = streamer.id
  LEFT JOIN last_7_days_usage recent_usage ON recent_usage.streamer_id = streamer.id
  WHERE streamer.is_active = TRUE
),
periodized AS (
  SELECT
    aggregated.publish_stats,
    aggregated.twitch_username,
    aggregated.twitch_display_name,
    aggregated.twitch_profile_image_url,
    period_values.period,
    period_values.card_count,
    period_values.redemption_count,
    period_values.total_points
  FROM aggregated
  CROSS JOIN LATERAL (
    VALUES
      (
        'last7Days'::TEXT,
        aggregated.last_7_days_card_count,
        aggregated.last_7_days_redemption_count,
        aggregated.last_7_days_total_points
      ),
      (
        'allTime'::TEXT,
        aggregated.all_time_card_count,
        aggregated.all_time_redemption_count,
        aggregated.all_time_total_points
      )
  ) AS period_values(period, card_count, redemption_count, total_points)
),
ranked AS (
  SELECT
    periodized.*,
    ROW_NUMBER() OVER (
      PARTITION BY periodized.period
      ORDER BY
        periodized.card_count DESC,
        periodized.redemption_count DESC,
        periodized.total_points DESC,
        CASE WHEN periodized.publish_stats THEN LOWER(periodized.twitch_username) END NULLS LAST,
        CASE WHEN periodized.publish_stats THEN periodized.twitch_username END NULLS LAST
    ) AS card_count_position,
    ROW_NUMBER() OVER (
      PARTITION BY periodized.period
      ORDER BY
        periodized.redemption_count DESC,
        periodized.total_points DESC,
        periodized.card_count DESC,
        CASE WHEN periodized.publish_stats THEN LOWER(periodized.twitch_username) END NULLS LAST,
        CASE WHEN periodized.publish_stats THEN periodized.twitch_username END NULLS LAST
    ) AS redemption_count_position,
    ROW_NUMBER() OVER (
      PARTITION BY periodized.period
      ORDER BY
        periodized.total_points DESC,
        periodized.redemption_count DESC,
        periodized.card_count DESC,
        CASE WHEN periodized.publish_stats THEN LOWER(periodized.twitch_username) END NULLS LAST,
        CASE WHEN periodized.publish_stats THEN periodized.twitch_username END NULLS LAST
    ) AS total_points_position
  FROM periodized
),
selected AS (
  SELECT
    ranked.*,
    ARRAY_REMOVE(ARRAY[
      CASE
        WHEN ranked.card_count > 0 AND ranked.card_count_position <= 100
        THEN 'cardCount'
      END,
      CASE
        WHEN ranked.redemption_count > 0 AND ranked.redemption_count_position <= 100
        THEN 'redemptionCount'
      END,
      CASE
        WHEN ranked.total_points > 0 AND ranked.total_points_position <= 100
        THEN 'totalPoints'
      END
    ]::TEXT[], NULL) AS ranked_metrics
  FROM ranked
),
period_catalog(period, sort_order) AS (
  VALUES ('last7Days'::TEXT, 1), ('allTime'::TEXT, 2)
),
period_payloads AS (
  SELECT
    period_catalog.period,
    period_catalog.sort_order,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'identity',
            CASE WHEN selected.publish_stats THEN jsonb_build_object(
              'twitchLogin', selected.twitch_username,
              'displayName', selected.twitch_display_name,
              'profileImageUrl', selected.twitch_profile_image_url
            ) ELSE NULL END,
          'cardCount', selected.card_count,
          'redemptionCount', selected.redemption_count,
          'totalPoints', selected.total_points,
          'rankedMetrics', selected.ranked_metrics
        )
        -- 匿名行を内部ID順にすると既知IDとの相対位置が識別の手掛かりになるため、
        -- 既存RPCと同じく公開値だけでレスポンス順を決める。
        ORDER BY
          selected.card_count DESC,
          selected.redemption_count DESC,
          selected.total_points DESC,
          CASE WHEN selected.publish_stats THEN LOWER(selected.twitch_username) END NULLS LAST,
          CASE WHEN selected.publish_stats THEN selected.twitch_username END NULLS LAST
      ) FILTER (
        WHERE selected.period IS NOT NULL
          AND CARDINALITY(selected.ranked_metrics) > 0
      ),
      '[]'::JSONB
    ) AS entries
  FROM period_catalog
  LEFT JOIN selected ON selected.period = period_catalog.period
  GROUP BY period_catalog.period, period_catalog.sort_order
)
SELECT jsonb_object_agg(
  period_payloads.period,
  period_payloads.entries
  ORDER BY period_payloads.sort_order
)
FROM period_payloads;
$$;

COMMENT ON FUNCTION get_live_directory_rankings_by_period() IS
  '/live向け直近7日間・全期間の各指標上位100件。publish_stats=falseは識別情報を返さない (issue #740)。配信者本人・登録済みBOTアカウントは集計から除外する';

REVOKE ALL ON FUNCTION get_live_directory_rankings_by_period() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_live_directory_rankings_by_period() TO service_role;

-- ---------------------------------------------------------------------------
-- 6) 一回限りのバックフィル（既に溜まった不正確なデータの是正）
-- ---------------------------------------------------------------------------
-- channel_point_usage_stats は gacha_history から完全に導出可能なので、
-- この2文は何度実行しても同じ結果になる（冪等）。

-- (a) 除外対象の既存行を落とす（配信者本人・BOT分）
DELETE FROM channel_point_usage_stats s
WHERE is_redemption_ranking_excluded(s.streamer_id, s.user_twitch_id);

-- (b) 残りを新述語で再集計する（N連の過少カウント是正）。
--     新述語は旧述語 (reward_cost > 0) の真の上位集合なので、
--     「既存行が0件になって消える」ケースは発生しない（DELETEは(a)だけで十分）。
INSERT INTO channel_point_usage_stats (
  streamer_id, user_twitch_id, username,
  total_points, redemption_count, last_redeemed_at
)
SELECT
  agg.streamer_id, agg.user_twitch_id, agg.username,
  agg.total_points, agg.redemption_count, agg.last_redeemed_at
FROM (
  SELECT
    h.streamer_id,
    h.user_twitch_id,
    COALESCE(MAX(h.user_twitch_username), h.user_twitch_id) AS username,
    COALESCE(SUM(h.reward_cost), 0)::BIGINT AS total_points,
    COUNT(*)::INTEGER AS redemption_count,
    MAX(h.redeemed_at) AS last_redeemed_at
  FROM gacha_history h
  WHERE h.reward_cost > 0 OR h.reward_id IS NOT NULL
  GROUP BY h.streamer_id, h.user_twitch_id
) agg
WHERE NOT is_redemption_ranking_excluded(agg.streamer_id, agg.user_twitch_id)
ON CONFLICT (streamer_id, user_twitch_id) DO UPDATE SET
  username = EXCLUDED.username,
  total_points = EXCLUDED.total_points,
  redemption_count = EXCLUDED.redemption_count,
  last_redeemed_at = EXCLUDED.last_redeemed_at,
  updated_at = NOW();
