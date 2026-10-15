-- migration-transaction: required
-- migration-providers: planetscale

-- 同志カード大賞（docich #934 / 設計 docs/features/doushi-card-corner.md §6）の
-- 公開読み取り専用ランキング RPC。
--
-- docich 側はこの JSON を表示するだけで、集計・正本・除外判定はすべて TwiCa 側に
-- 置く。認証必須 API を service トークンで叩く案は docich に資格情報を増やすため
-- 採らず、後続の 20261015050000 migration の wrapper で配信者の公開 opt-in を
-- 強制する。公開 route は wrapper だけを呼ぶ（設計 §6）。
--
-- 集計述語・除外判定・同率決定順は既存の正本に合わせる:
--   - 対象述語 (reward_cost > 0 OR reward_id IS NOT NULL)
--     （20260819120000_exclude_streamer_and_bot_from_redemption_rankings.sql の
--       【新しい述語】。N連を N 件として数え、レイドガチャ・手動QAドローを除外）
--   - 除外 is_redemption_ranking_excluded(streamer_id, user_twitch_id)
--     （配信者本人 / streamer BOT / system BOT）
--   - 2段 GROUP BY + OFFSET 0 フェンス（同一migrationの実測コメント準拠:
--     GROUP BY キーにのみ依存する述語はプランナが GROUP BY 前の行単位へ引き下げ
--     てしまうため、集約結果を OFFSET 0 で確定させてから除外判定する）
--
-- 返却フィールドは設計 §6 の allowlist のみ。user_twitch_id / card_id などの内部 id、
-- token・IP・メールは返さない（同率決定は関数内部でだけ参照する）。
--
-- ③ 蒐集カード数は所持ベース（全期間）で、period の影響を受けない（設計 §3）。
-- ③ にも除外判定を適用する（設計 §3「提案（§7-8、推奨は適用）」に従う。owner 承認待ち
-- の提案値のため、PR 本文にも未確定事項として記録する）。

CREATE OR REPLACE FUNCTION public.get_card_ranking(
  p_streamer_id uuid,
  p_period text DEFAULT 'all',
  p_limit integer DEFAULT 10
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_period text := COALESCE(p_period, 'all');
  v_limit integer := COALESCE(p_limit, 10);
  v_from timestamp with time zone;
  v_generated timestamp with time zone := now();
  v_by_count jsonb;
  v_by_points jsonb;
  v_by_unique jsonb;
  v_popular jsonb;
  v_card_type_total integer;
  v_note text;
BEGIN
  IF p_streamer_id IS NULL THEN
    RAISE EXCEPTION 'card_ranking: streamer id is required';
  END IF;
  IF v_period NOT IN ('all', '7d', '30d') THEN
    RAISE EXCEPTION 'card_ranking: invalid period';
  END IF;
  -- 上位表示は 10 件中心だが、将来のページング/余裕分取得に備えて 1..100 を許容する。
  -- 範囲外は fail-closed（公開 route 側は 1..50 で検証し、それ以外は 400）。
  IF v_limit < 1 OR v_limit > 100 THEN
    RAISE EXCEPTION 'card_ranking: invalid limit';
  END IF;

  v_from := CASE v_period
    WHEN '7d' THEN now() - INTERVAL '7 days'
    WHEN '30d' THEN now() - INTERVAL '30 days'
    ELSE NULL
  END;

  -- ① 排出枚数: N連は N 件。同率順 redemption_count DESC → last_redeemed_at DESC
  --             → user_twitch_id ASC（設計 §3.1）。
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'rank', ranked.rn,
      'username', ranked.username,
      'redemption_count', ranked.redemption_count
    )
    ORDER BY ranked.rn
  ), '[]'::JSONB)
  INTO v_by_count
  FROM (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY grouped.redemption_count DESC,
                 grouped.last_redeemed_at DESC,
                 grouped.user_twitch_id ASC
      ) AS rn,
      grouped.username,
      grouped.redemption_count
    FROM (
      SELECT
        history.user_twitch_id,
        COALESCE(MAX(history.user_twitch_username), history.user_twitch_id) AS username,
        COUNT(*)::INTEGER AS redemption_count,
        MAX(history.redeemed_at) AS last_redeemed_at
      FROM gacha_history history
      WHERE history.streamer_id = p_streamer_id
        AND (v_from IS NULL OR history.redeemed_at >= v_from)
        AND (history.reward_cost > 0 OR history.reward_id IS NOT NULL)
      GROUP BY history.user_twitch_id
      OFFSET 0
    ) grouped
    WHERE NOT is_redemption_ranking_excluded(p_streamer_id, grouped.user_twitch_id)
  ) ranked
  WHERE ranked.rn <= v_limit;

  -- ② 使用チャネルポイント: total_points DESC → redemption_count DESC
  --                          → last_redeemed_at DESC → user_twitch_id ASC（設計 §3.1）。
  --    SUM(reward_cost) は NULL を無視するため N連の cost は先頭行分だけで二重計上しない。
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'rank', ranked.rn,
      'username', ranked.username,
      'total_points', ranked.total_points,
      'redemption_count', ranked.redemption_count
    )
    ORDER BY ranked.rn
  ), '[]'::JSONB)
  INTO v_by_points
  FROM (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY grouped.total_points DESC,
                 grouped.redemption_count DESC,
                 grouped.last_redeemed_at DESC,
                 grouped.user_twitch_id ASC
      ) AS rn,
      grouped.username,
      grouped.total_points,
      grouped.redemption_count
    FROM (
      SELECT
        history.user_twitch_id,
        COALESCE(MAX(history.user_twitch_username), history.user_twitch_id) AS username,
        COALESCE(SUM(history.reward_cost), 0)::BIGINT AS total_points,
        COUNT(*)::INTEGER AS redemption_count,
        MAX(history.redeemed_at) AS last_redeemed_at
      FROM gacha_history history
      WHERE history.streamer_id = p_streamer_id
        AND (v_from IS NULL OR history.redeemed_at >= v_from)
        AND (history.reward_cost > 0 OR history.reward_id IS NOT NULL)
      GROUP BY history.user_twitch_id
      OFFSET 0
    ) grouped
    WHERE NOT is_redemption_ranking_excluded(p_streamer_id, grouped.user_twitch_id)
  ) ranked
  WHERE ranked.rn <= v_limit;

  -- ③ 蒐集カード数: 所持ベース（全期間・period の影響を受けない）。is_active な
  --    カードのユニーク種類数。draw_count（第2キー）は get_gacha_users_for_streamer
  --    と同じく gacha_history の全行数（述語なし）を使う。
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'rank', ranked.rn,
      'username', ranked.username,
      'unique_count', ranked.unique_count,
      'total_cards', ranked.total_cards
    )
    ORDER BY ranked.rn
  ), '[]'::JSONB)
  INTO v_by_unique
  FROM (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY held.unique_count DESC,
                 held.draw_count DESC,
                 held.user_twitch_id ASC
      ) AS rn,
      COALESCE(held.draws_username, held.username, held.user_twitch_id) AS username,
      held.unique_count,
      held.total_cards
    FROM (
      SELECT
        collected.user_twitch_id,
        collected.username,
        collected.unique_count,
        collected.total_cards,
        COALESCE(draws.draw_count, 0)::BIGINT AS draw_count,
        draws.username AS draws_username
      FROM (
        SELECT
          u.twitch_user_id AS user_twitch_id,
          u.twitch_username AS username,
          COUNT(DISTINCT owned.card_id)::INTEGER AS unique_count,
          COUNT(*)::INTEGER AS total_cards
        FROM user_cards owned
        JOIN users u ON u.id = owned.user_id
        JOIN cards c ON c.id = owned.card_id
        WHERE c.streamer_id = p_streamer_id
          AND c.is_active = true
        GROUP BY u.twitch_user_id, u.twitch_username
        OFFSET 0
      ) collected
      LEFT JOIN (
        SELECT
          history.user_twitch_id,
          MAX(history.user_twitch_username) AS username,
          COUNT(*)::BIGINT AS draw_count
        FROM gacha_history history
        WHERE history.streamer_id = p_streamer_id
        GROUP BY history.user_twitch_id
        OFFSET 0
      ) draws ON draws.user_twitch_id = collected.user_twitch_id
    ) held
    WHERE NOT is_redemption_ranking_excluded(p_streamer_id, held.user_twitch_id)
  ) ranked
  WHERE ranked.rn <= v_limit;

  -- 母数（ページ3の「◯/全カード種類数」用）。is_active のみを母数にする。
  SELECT COUNT(*)::INTEGER
  INTO v_card_type_total
  FROM cards
  WHERE streamer_id = p_streamer_id AND is_active = true;

  -- ④ 人気カード: 期間内のカード別枚数と人数。①②と同じ2段構成で除外判定を
  --    グループ単位に適用し、人気順ソート（actual_count DESC → drawer_count DESC
  --    → card_id ASC）を API 側で確定させる（現行 get_gacha_drop_stats は
  --    レアリティ順で返すため、docich にソートを押し付けない。設計 §3/§3.1）。
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'rank', ranked.rn,
      'card_name', ranked.card_name,
      'actual_count', ranked.actual_count,
      'drawer_count', ranked.drawer_count
    )
    ORDER BY ranked.rn
  ), '[]'::JSONB)
  INTO v_popular
  FROM (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY per_card.actual_count DESC,
                 per_card.drawer_count DESC,
                 per_card.card_id ASC
      ) AS rn,
      per_card.card_id,
      per_card.card_name,
      per_card.actual_count,
      per_card.drawer_count
    FROM (
      SELECT
        draws.card_id,
        card.name AS card_name,
        SUM(draws.draws)::INTEGER AS actual_count,
        COUNT(DISTINCT draws.user_twitch_id)::INTEGER AS drawer_count
      FROM (
        SELECT
          per_user.card_id,
          per_user.user_twitch_id,
          per_user.draws
        FROM (
          SELECT
            history.card_id,
            history.user_twitch_id,
            COUNT(*)::INTEGER AS draws
          FROM gacha_history history
          WHERE history.streamer_id = p_streamer_id
            AND (v_from IS NULL OR history.redeemed_at >= v_from)
            AND (history.reward_cost > 0 OR history.reward_id IS NOT NULL)
          GROUP BY history.card_id, history.user_twitch_id
          OFFSET 0
        ) per_user
        WHERE NOT is_redemption_ranking_excluded(p_streamer_id, per_user.user_twitch_id)
      ) draws
      JOIN cards card ON card.id = draws.card_id
      GROUP BY draws.card_id, card.name
    ) per_card
  ) ranked
  WHERE ranked.rn <= v_limit;

  v_note := 'N連はN件 / 配信者本人とBOTを除く';
  IF v_period = 'all' THEN
    v_note := v_note || ' / 全期間（2026-07-04以前のN連2枚目以降は含みません）';
  ELSIF v_period = '7d' THEN
    v_note := v_note || ' / 直近7日';
  ELSE
    v_note := v_note || ' / 直近30日';
  END IF;

  RETURN jsonb_build_object(
    'generated_at', to_char(v_generated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'period', v_period,
    'metric_labels', jsonb_build_object(
      'by_count', '排出枚数',
      'by_points', '使用チャネルポイント',
      'by_unique', '蒐集カード数',
      'popular_cards', '人気カード'
    ),
    'note', v_note,
    'card_type_total', v_card_type_total,
    'by_count', v_by_count,
    'by_points', v_by_points,
    'by_unique', v_by_unique,
    'popular_cards', v_popular
  );
END;
$$;

-- 資格情報なしの公開API経由で docich が読めるようにする（既存RPCと同じ扱い）。
REVOKE ALL ON FUNCTION public.get_card_ranking(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_card_ranking(uuid, text, integer) TO service_role;
