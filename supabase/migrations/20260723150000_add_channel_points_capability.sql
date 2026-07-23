-- 非Affiliate配信者向けChannel Points Capability判定・オプトイン基盤 (#788 子B #790)
--
-- 背景:
-- Twitchの「Monetization for All」制度により、Affiliate/Partnerでなくても
-- Channel Pointsを利用できるユーザーが登場した。twica側は非破壊のCapability
-- Probe（GET /helix/channel_points/custom_rewards）でTwitch側の利用可否を判定し、
-- 判定結果とtwica配信者機能への明示的オプトインを users に永続化する。
--
-- channel_points_capability: 最後に得た「確定状態」(200/401/403相当)。
--   429/5xx/network error等の一時失敗はここへ保存しない。
-- channel_points_capability_checked_at: 確定状態を最後に得た日時。
-- channel_points_enabled: 非Affiliateユーザーがtwica配信者機能を明示的に
--   有効化したか。TwitchネイティブのChannel Points設定とは別概念。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS channel_points_capability TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS channel_points_capability_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS channel_points_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_channel_points_capability_check;
ALTER TABLE users
  ADD CONSTRAINT users_channel_points_capability_check
  CHECK (channel_points_capability IN ('available', 'unavailable', 'reauth_required', 'unknown'));

-- 明示的有効化 + streamers UPSERT を単一トランザクションで行うRPC。
-- 00060 (exchange_duplicate_card_for_stones) と同じ SECURITY DEFINER + search_path 固定方針。
--
-- 戻り値は streamer_id のみ（INSERT ... ON CONFLICT の結果だけでは「新規作成か
-- 既存更新か」を安全に判定できず、呼び出し側もその真偽値を使わないため、
-- 誤りうる判定ロジックを持ち込むより単純化する）。
--
-- users 行を FOR UPDATE で行ロックしてから capability を再検証するため、
-- 同時実行・二重送信でも streamers 行が重複作成されず、capability が
-- 'available' でなければ有効化されない。
CREATE OR REPLACE FUNCTION enable_channel_points_streamer_access(p_twitch_user_id TEXT)
RETURNS UUID AS $$
DECLARE
  v_user RECORD;
  v_streamer_id UUID;
BEGIN
  IF p_twitch_user_id IS NULL OR p_twitch_user_id = '' THEN
    RAISE EXCEPTION 'TWITCH_USER_ID_REQUIRED';
  END IF;

  SELECT twitch_user_id, twitch_username, twitch_display_name, twitch_profile_image_url,
         channel_points_capability
    INTO v_user
    FROM users
    WHERE twitch_user_id = p_twitch_user_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  IF v_user.channel_points_capability IS DISTINCT FROM 'available' THEN
    RAISE EXCEPTION 'CAPABILITY_NOT_AVAILABLE';
  END IF;

  -- updated_atは既存の update_users_updated_at トリガー(00001)が自動更新するため
  -- ここでは明示的に触らない。
  UPDATE users SET channel_points_enabled = TRUE
    WHERE twitch_user_id = p_twitch_user_id;

  -- 既存streamer行がある場合はプロフィール列のみ更新し、reward_id/collection/
  -- sound/chat設定等の既存カスタマイズを一切上書きしない。
  INSERT INTO streamers (twitch_user_id, twitch_username, twitch_display_name, twitch_profile_image_url)
    VALUES (v_user.twitch_user_id, v_user.twitch_username, v_user.twitch_display_name, v_user.twitch_profile_image_url)
    ON CONFLICT (twitch_user_id) DO UPDATE SET
      twitch_username = EXCLUDED.twitch_username,
      twitch_display_name = EXCLUDED.twitch_display_name,
      twitch_profile_image_url = EXCLUDED.twitch_profile_image_url
    RETURNING id INTO v_streamer_id;

  RETURN v_streamer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION enable_channel_points_streamer_access(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enable_channel_points_streamer_access(TEXT) TO service_role;
