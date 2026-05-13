-- Supabase Data API privilege hardening
--
-- Supabase no longer implicitly exposes newly-created public-schema tables to
-- PostgREST/GraphQL roles. Keep table privileges explicit and aligned with the
-- existing RLS policies.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Public read surfaces. RLS still limits rows to active records.
GRANT SELECT ON TABLE public.streamers TO anon, authenticated;
GRANT SELECT ON TABLE public.cards TO anon, authenticated;

-- Existing authenticated-only RLS policy for streamer-owned reward settings.
GRANT SELECT ON TABLE public.streamer_additional_gacha_rewards TO authenticated;

-- Server-side application access through the elevated Supabase key.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cards TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_cards TO service_role;
GRANT SELECT, INSERT ON TABLE public.gacha_history TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.battles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.battle_stats TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storage_usage TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.blob_files TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_additional_gacha_rewards TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.errors TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_storage_bonus TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.announcements TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.announcement_reads TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_codes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_licenses TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_inquiries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_inquiry_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_completions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_point_usage_stats TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.twitch_bot_accounts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_chat_sender_settings TO service_role;
