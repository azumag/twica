-- Issue #689: both production and preview currently inherit DELETE on
-- public.gacha_history through Supabase's historical default privileges.
-- Migration 00047 only documents SELECT/INSERT, so a newly reconstructed
-- database could diverge from the live environments and break
-- DELETE /api/gacha-history/[id].  Record the live contract explicitly in a
-- forward-only migration instead of editing already-applied migration 00047.
--
-- GRANT is idempotent in PostgreSQL.  Existing projects keep the same effective
-- permission; fresh/rebuilt projects no longer depend on provider defaults.
GRANT DELETE ON TABLE public.gacha_history TO service_role;
