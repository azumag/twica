-- migration-transaction: required
-- migration-providers: planetscale
--
-- #632 / #738: 配信中ページ（Live Directory）の公開オプトイン基盤
--
-- 配信者が個別に「配信中を公表」と「統計を公開」をオプトインした場合のみ、
-- /live に掲載される。デフォルトは両方 OFF（公開ディレクトリ掲載は明示的同意が
-- 原則のため）。加法的（additive）な変更のため、既存カード・既存コードに影響はない。
ALTER TABLE streamers
  ADD COLUMN IF NOT EXISTS publish_live_status BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS publish_stats BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN streamers.publish_live_status IS '配信中ディレクトリ(/live)への掲載オプトイン (issue #632)';
COMMENT ON COLUMN streamers.publish_stats IS '/liveでのカード統計公開オプトイン (issue #632)';

-- 公開ディレクトリ用 read RPC: オプトイン配信者と公開可能な集計のみを返す。
-- RETURNS JSONB とする（RETURNS TABLE にしない）。pg直結パリティヘルパー
-- executeDashboardRpcPg は「RPCがすべて RETURNS JSONB だからスカラーSELECTで
-- 両経路が同一形状になる」前提であり、RETURNS TABLE + BIGINT だと postgres.js
-- （fetch_types: false）が int8 を文字列で返し PostgREST 経路（数値）と型パリティが
-- 壊れるため。JSONB 内では数値は JSON number に正規化される。
--
-- フィルタはサーバサイドで強制: publish_live_status = TRUE AND is_active = TRUE
-- （非オプトイン配信者の行を返さない。フロント側フィルタは禁止）。
-- publish_stats = FALSE の配信者は cardCount / redemptionCount を NULL で返す。
-- 集計はロールアップ / 軽量 COUNT のみ: cardCount は cards の is_active 件数、
-- redemptionCount は channel_point_usage_stats の累積（gacha_history の
-- フルスキャンはしない）。redemption_count は reward_cost > 0 の行のみの集計のため
-- 「チャネルポイント引換数」を表す（レイド / 無償ドローは含まない）。
CREATE OR REPLACE FUNCTION get_live_directory_streamers()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
SELECT COALESCE(jsonb_agg(
  jsonb_build_object(
    'streamerId', s.id,
    'twitchUserId', s.twitch_user_id,
    'twitchUsername', s.twitch_username,
    'twitchDisplayName', s.twitch_display_name,
    'twitchProfileImageUrl', s.twitch_profile_image_url,
    'publishStats', s.publish_stats,
    'cardCount',
      CASE WHEN s.publish_stats THEN cc.card_count ELSE NULL END,
    'redemptionCount',
      CASE WHEN s.publish_stats THEN us.redemption_count ELSE NULL END
  )
  ORDER BY s.twitch_display_name, s.id
), '[]'::jsonb)
FROM streamers s
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INTEGER AS card_count
  FROM cards c
  WHERE c.streamer_id = s.id
    AND c.is_active
) cc ON TRUE
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(us.redemption_count), 0)::INTEGER AS redemption_count
  FROM channel_point_usage_stats us
  WHERE us.streamer_id = s.id
) us ON TRUE
WHERE s.publish_live_status = TRUE
  AND s.is_active = TRUE;
$$;

REVOKE ALL ON FUNCTION get_live_directory_streamers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_live_directory_streamers() TO service_role;
