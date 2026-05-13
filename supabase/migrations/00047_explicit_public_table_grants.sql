-- Supabase Data API privilege hardening
--
-- Supabase no longer implicitly exposes newly-created public-schema tables to
-- PostgREST/GraphQL roles. Keep table privileges explicit and aligned with the
-- existing RLS policies.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Public read surfaces. RLS still limits rows to active records.
-- Existing authenticated-only RLS policy for streamer-owned reward settings.
DO $$
BEGIN
  IF to_regclass('public.streamers') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.streamers TO anon, authenticated';
  END IF;
  IF to_regclass('public.cards') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.cards TO anon, authenticated';
  END IF;
  IF to_regclass('public.streamer_additional_gacha_rewards') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.streamer_additional_gacha_rewards TO authenticated';
  END IF;
END
$$;

-- Server-side application access through the elevated Supabase key.
-- Some long-lived environments do not have every historical table, so make
-- these grants conditional while keeping the intended privileges explicit.
DO $$
BEGIN
  IF to_regclass('public.streamers') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamers TO service_role';
  END IF;
  IF to_regclass('public.cards') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cards TO service_role';
  END IF;
  IF to_regclass('public.users') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO service_role';
  END IF;
  IF to_regclass('public.user_cards') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_cards TO service_role';
  END IF;
  IF to_regclass('public.gacha_history') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.gacha_history TO service_role';
  END IF;
  IF to_regclass('public.battles') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.battles TO service_role';
  END IF;
  IF to_regclass('public.battle_stats') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.battle_stats TO service_role';
  END IF;
  IF to_regclass('public.storage_usage') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.storage_usage TO service_role';
  END IF;
  IF to_regclass('public.blob_files') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.blob_files TO service_role';
  END IF;
  IF to_regclass('public.streamer_additional_gacha_rewards') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_additional_gacha_rewards TO service_role';
  END IF;
  IF to_regclass('public.errors') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.errors TO service_role';
  END IF;
  IF to_regclass('public.streamer_storage_bonus') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_storage_bonus TO service_role';
  END IF;
  IF to_regclass('public.announcements') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.announcements TO service_role';
  END IF;
  IF to_regclass('public.announcement_reads') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.announcement_reads TO service_role';
  END IF;
  IF to_regclass('public.support_codes') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_codes TO service_role';
  END IF;
  IF to_regclass('public.user_licenses') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_licenses TO service_role';
  END IF;
  IF to_regclass('public.support_inquiries') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_inquiries TO service_role';
  END IF;
  IF to_regclass('public.support_inquiry_messages') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.support_inquiry_messages TO service_role';
  END IF;
  IF to_regclass('public.collection_completions') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_completions TO service_role';
  END IF;
  IF to_regclass('public.channel_point_usage_stats') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_point_usage_stats TO service_role';
  END IF;
  IF to_regclass('public.twitch_bot_accounts') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.twitch_bot_accounts TO service_role';
  END IF;
  IF to_regclass('public.streamer_chat_sender_settings') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_chat_sender_settings TO service_role';
  END IF;
END
$$;
