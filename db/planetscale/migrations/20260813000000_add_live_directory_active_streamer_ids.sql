-- migration-transaction: required
-- migration-providers: planetscale
--
-- #951: /live に「現在ライブ中の配信者数」を表示するための母集団取得RPC。
--
-- 既存 get_live_directory_streamers() は publish_live_status=true（オプトイン）の
-- 配信者のみを返すため、一覧には出さないが人数だけは数える、という #951 の要件を
-- 満たせない。このRPCはオプトインの有無に関わらず全active配信者の
-- twitch_user_id だけを返す。identity（ユーザー名・表示名・画像URL）は一切返さず、
-- サーバ側でのみ Helix ライブ判定に使う。RSC/KV境界を通過するのは整数の人数のみ。
--
-- 新RPCは加法的（CREATE OR REPLACE）で既存RPCを変更しないため、デプロイ窓の
-- 旧アプリへ退行を与えない。アプリ先行デプロイ時は executeDashboardRpcPg が
-- 42883 を正規化し、人数表示だけが fail-closed で非表示になる。
CREATE OR REPLACE FUNCTION get_live_directory_active_streamer_ids()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
SELECT COALESCE(
  jsonb_agg(s.twitch_user_id ORDER BY s.twitch_user_id),
  '[]'::jsonb
)
FROM streamers s
WHERE s.is_active = TRUE
  AND s.twitch_user_id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION get_live_directory_active_streamer_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_live_directory_active_streamer_ids() TO service_role;
