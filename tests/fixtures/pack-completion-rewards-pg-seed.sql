-- Dedicated disposable CI PostgreSQL only, after the full schema migrations.
-- The real-PG test uses these fixed identities and resets ownership/settings
-- itself. Seed only base rows; keep the migrated constraints and RPCs intact.
-- Run once with psql --set=ON_ERROR_STOP=1 --single-transaction. Never use a
-- shared database: pack-completion-rewards-pg.test.ts truncates reward tables
-- and user_cards, so it must run after the trade fixtures/tests have finished.

INSERT INTO public.streamers (
  id, twitch_user_id, twitch_username, twitch_display_name, card_pack_names
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'pack-pg-streamer', 'pack_pg_streamer', 'Pack PG Streamer', '["A","B"]'
);

INSERT INTO public.users (
  id, twitch_user_id, twitch_username, twitch_display_name
) VALUES (
  '00000000-0000-0000-0000-000000000002',
  'viewer', 'pack_pg_viewer', 'Pack PG Viewer'
);

-- Both cards belong to the default pack; A remains empty for the negative
-- completion case. The inactive bonus must never count as a prerequisite.
INSERT INTO public.cards (id, streamer_id, name, is_active, collection_name)
VALUES
  (
    '00000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    'Pack PG Normal', true, NULL
  ),
  (
    '00000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001',
    'Pack PG Bonus', false, NULL
  );
