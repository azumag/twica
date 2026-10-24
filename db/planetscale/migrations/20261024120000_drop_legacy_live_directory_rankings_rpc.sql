-- migration-transaction: required
-- migration-providers: planetscale
--
-- Issue #933: contract migration removing the legacy live-directory ranking RPC
-- `get_live_directory_rankings()` (introduced by
-- supabase/migrations/20260811120000_add_live_directory_rankings.sql).
--
-- The period-aware successor `get_live_directory_rankings_by_period()` has been the only
-- application-side caller since the #740 period switch landed in production
-- (2026-08-11, release PR #936); the app now calls only
-- `get_live_directory_rankings_by_period()` and KV `live-directory:rankings:v3`
-- (verified: grep of src/ returns 0 references to the legacy RPC). The read-only
-- observation workflow (db-readonly-check-live-directory-legacy-rpc{,-production}.yml)
-- confirms zero production calls before this migration is applied.
--
-- This file is intentionally non-additive (DROP FUNCTION) and is applied only via
-- `scripts/db-migrate.js --allow-non-additive` in the contract phase, with human
-- control of deploy ordering. It does not touch gacha/overlay/chat runtime paths.

DROP FUNCTION IF EXISTS public.get_live_directory_rankings();
