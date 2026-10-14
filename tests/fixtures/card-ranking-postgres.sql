\set ON_ERROR_STOP on

-- docich #934 / 設計 docs/features/doushi-card-corner.md §6 の公開ランキング RPC
-- get_card_ranking を、CI の PostgreSQL 17 へ適用済みの状態で実際に呼び出して
-- 検証する（tests/fixtures/redemption-ranking-exclusions-postgres.sql と同じ方式）。
--
-- SQL 文字列テストでは検証できない以下を実 DB で確認する:
--   1. 対象述語 (reward_cost > 0 OR reward_id IS NOT NULL): N連を N 件として数え、
--      レイドガチャ / 手動QAドロー（両方 NULL）を落とす
--   2. is_redemption_ranking_excluded: 配信者本人・登録済み BOT の行を落とす
--   3. 同率決定順（設計 §3.1）: last_redeemed_at DESC → user_twitch_id ASC など
--   4. period 過濾（all / 7d）: ③ 蒐集カード数だけは所持ベースで period の影響を受けない
--   5. 返却フィールドが allowlist のみ（user_twitch_id / card_id を返さない）
--   6. 不正な period / limit は fail-closed（例外）
--
-- データはこの fixture 内で作り、他 fixture の id 空間（30000000- / 40000000-）を
-- 使わない（50000000- 採番）。

INSERT INTO public.streamers (id, twitch_user_id, twitch_username, twitch_display_name)
VALUES ('50000000-0000-4000-8000-000000000001', 'cr-streamer-self', 'cr-streamer-self', 'CR Streamer');

INSERT INTO public.users (id, twitch_user_id, twitch_username, twitch_display_name) VALUES
  ('50000000-0000-4000-8000-000000000101', 'cr-viewer-a', 'viewerA', 'Viewer A'),
  ('50000000-0000-4000-8000-000000000102', 'cr-viewer-b', 'viewerB', 'Viewer B'),
  ('50000000-0000-4000-8000-000000000103', 'cr-viewer-c', 'viewerC', 'Viewer C'),
  ('50000000-0000-4000-8000-000000000104', 'cr-viewer-d', 'viewerD', 'Viewer D'),
  ('50000000-0000-4000-8000-000000000105', 'cr-viewer-e', 'viewerE', 'Viewer E'),
  ('50000000-0000-4000-8000-000000000106', 'cr-viewer-f', 'viewerF', 'Viewer F'),
  ('50000000-0000-4000-8000-00000000102b', 'cr-streamer-self', 'cr-streamer-self', 'CR Streamer');

INSERT INTO public.cards (id, streamer_id, name, rarity, drop_rate, is_active) VALUES
  ('50000000-0000-4000-8000-0000000000c1', '50000000-0000-4000-8000-000000000001', 'CR Card One', 'common', 0.5, true),
  ('50000000-0000-4000-8000-0000000000c2', '50000000-0000-4000-8000-000000000001', 'CR Card Two', 'rare', 0.3, true),
  ('50000000-0000-4000-8000-0000000000c3', '50000000-0000-4000-8000-000000000001', 'CR Card Three', 'epic', 0.1, true),
  -- ③ の母数・所持数から落ちることを確認するための非 active カード。
  ('50000000-0000-4000-8000-0000000000c9', '50000000-0000-4000-8000-000000000001', 'CR Card Retired', 'common', 0.1, false);

-- 登録済み streamer BOT（除外対象）。
INSERT INTO public.twitch_bot_accounts (
  id, owner_type, streamer_id, twitch_user_id, twitch_username, twitch_display_name,
  twitch_access_token, twitch_refresh_token, twitch_token_expires_at
) VALUES (
  '50000000-0000-4000-8000-0000000000b1', 'streamer',
  '50000000-0000-4000-8000-000000000001',
  'cr-bot-1', 'crbot', 'CR Bot', 'x', 'x', now() + INTERVAL '1 hour'
);

-- ---------------------------------------------------------------------------
-- gacha_history
--   viewer-a: N連3枚（reward_cost は先頭行のみ 300、reward_id は全行）
--   viewer-b: 直近1枚(100pt) + 10日前1枚(500pt)
--   viewer-d: 10日前に3枚（300pt）
--   viewer-e / viewer-f: 同時刻・同枚数・同ポイント（user_twitch_id 昇順の最終決定を検証）
--   viewer-c: レイドガチャ（reward_cost/reward_id とも NULL）→ 述語で除外
--   配信者本人 / BOT: 除外判定で除外
-- ---------------------------------------------------------------------------
INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id, redeemed_at, event_id, reward_cost, reward_id
) VALUES
  ('50000000-0000-4000-8000-000000000201', 'cr-viewer-a', 'viewerA',
   '50000000-0000-4000-8000-0000000000c1', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '1 day', 'evt-a-1', 300, 'rw-a'),
  ('50000000-0000-4000-8000-000000000202', 'cr-viewer-a', 'viewerA',
   '50000000-0000-4000-8000-0000000000c1', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '1 day', 'evt-a-1-2', NULL, 'rw-a'),
  ('50000000-0000-4000-8000-000000000203', 'cr-viewer-a', 'viewerA',
   '50000000-0000-4000-8000-0000000000c2', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '1 day', 'evt-a-1-3', NULL, 'rw-a'),
  ('50000000-0000-4000-8000-000000000204', 'cr-viewer-b', 'viewerB',
   '50000000-0000-4000-8000-0000000000c1', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '1 day', 'evt-b-1', 100, 'rw-b'),
  ('50000000-0000-4000-8000-000000000205', 'cr-viewer-b', 'viewerB',
   '50000000-0000-4000-8000-0000000000c1', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '10 days', 'evt-b-2', 500, 'rw-b2'),
  ('50000000-0000-4000-8000-000000000206', 'cr-viewer-d', 'viewerD',
   '50000000-0000-4000-8000-0000000000c3', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '10 days', 'evt-d-1', 100, 'rw-d'),
  ('50000000-0000-4000-8000-000000000207', 'cr-viewer-d', 'viewerD',
   '50000000-0000-4000-8000-0000000000c3', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '10 days', 'evt-d-1-2', NULL, 'rw-d'),
  ('50000000-0000-4000-8000-000000000208', 'cr-viewer-d', 'viewerD',
   '50000000-0000-4000-8000-0000000000c3', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '10 days', 'evt-d-1-3', NULL, 'rw-d'),
  ('50000000-0000-4000-8000-000000000209', 'cr-viewer-e', 'viewerE',
   '50000000-0000-4000-8000-0000000000c2', '50000000-0000-4000-8000-000000000001',
   TIMESTAMPTZ '2026-10-01T00:00:00+00:00', 'evt-e-1', 100, 'rw-e'),
  ('50000000-0000-4000-8000-000000000210', 'cr-viewer-e', 'viewerE',
   '50000000-0000-4000-8000-0000000000c2', '50000000-0000-4000-8000-000000000001',
   TIMESTAMPTZ '2026-10-01T00:00:00+00:00', 'evt-e-1-2', NULL, 'rw-e'),
  ('50000000-0000-4000-8000-000000000211', 'cr-viewer-f', 'viewerF',
   '50000000-0000-4000-8000-0000000000c2', '50000000-0000-4000-8000-000000000001',
   TIMESTAMPTZ '2026-10-01T00:00:00+00:00', 'evt-f-1', 100, 'rw-f'),
  ('50000000-0000-4000-8000-000000000212', 'cr-viewer-f', 'viewerF',
   '50000000-0000-4000-8000-0000000000c2', '50000000-0000-4000-8000-000000000001',
   TIMESTAMPTZ '2026-10-01T00:00:00+00:00', 'evt-f-1-2', NULL, 'rw-f'),
  -- レイドガチャ（述語対象外）
  ('50000000-0000-4000-8000-000000000213', 'cr-viewer-c', 'viewerC',
   '50000000-0000-4000-8000-0000000000c3', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '1 day', 'evt-c-raid', NULL, NULL),
  -- 配信者本人（除外判定）
  ('50000000-0000-4000-8000-000000000214', 'cr-streamer-self', 'cr-streamer-self',
   '50000000-0000-4000-8000-0000000000c1', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '1 day', 'evt-self', 1000, 'rw-self'),
  -- 登録済み BOT（除外判定）
  ('50000000-0000-4000-8000-000000000215', 'cr-bot-1', 'crbot',
   '50000000-0000-4000-8000-0000000000c2', '50000000-0000-4000-8000-000000000001',
   now() - INTERVAL '1 day', 'evt-bot', 700, 'rw-bot');

-- ③ 所持ベース: viewer-a は active 2種（非 active 1種は数えない）、viewer-b は 1種、
-- 配信者本人は除外判定で落ちる。
INSERT INTO public.user_cards (id, user_id, card_id, obtained_at) VALUES
  ('50000000-0000-4000-8000-000000000301',
   '50000000-0000-4000-8000-000000000101', '50000000-0000-4000-8000-0000000000c1', now()),
  ('50000000-0000-4000-8000-000000000302',
   '50000000-0000-4000-8000-000000000101', '50000000-0000-4000-8000-0000000000c2', now()),
  ('50000000-0000-4000-8000-000000000303',
   '50000000-0000-4000-8000-000000000101', '50000000-0000-4000-8000-0000000000c9', now()),
  ('50000000-0000-4000-8000-000000000304',
   '50000000-0000-4000-8000-000000000102', '50000000-0000-4000-8000-0000000000c1', now()),
  ('50000000-0000-4000-8000-000000000305',
   '50000000-0000-4000-8000-00000000102b', '50000000-0000-4000-8000-0000000000c3', now());

-- ---------------------------------------------------------------------------
-- 本体検証
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_all JSONB;
  v_week JSONB;
  v_row JSONB;
  v_names TEXT;
BEGIN
  v_all := public.get_card_ranking('50000000-0000-4000-8000-000000000001', 'all', 10);
  v_week := public.get_card_ranking('50000000-0000-4000-8000-000000000001', '7d', 10);

  IF v_all->>'period' <> 'all' THEN
    RAISE EXCEPTION 'period が echo されていない: %', v_all->>'period';
  END IF;
  IF position('N連はN件' IN (v_all->>'note')) = 0 THEN
    RAISE EXCEPTION 'note に N連はN件 が含まれていない: %', v_all->>'note';
  END IF;
  IF (v_all->>'card_type_total')::INTEGER <> 3 THEN
    RAISE EXCEPTION 'card_type_total が active カード数(3)と一致しない: %', v_all->>'card_type_total';
  END IF;

  -- ① 排出枚数（all）: a(3, 直近) → d(3, 10日前) → b(2, 10/05) → e → f（同時刻は id 昇順）
  SELECT string_agg(e->>'username', ',' ORDER BY (e->>'rank')::INTEGER)
  INTO v_names FROM jsonb_array_elements(v_all->'by_count') e;
  IF v_names <> 'viewerA,viewerD,viewerB,viewerE,viewerF' THEN
    RAISE EXCEPTION 'by_count(all) の並びが不正: %', v_names;
  END IF;
  v_row := v_all->'by_count'->0;
  IF (v_row->>'rank')::INTEGER <> 1 OR (v_row->>'redemption_count')::INTEGER <> 3 THEN
    RAISE EXCEPTION 'by_count 先頭行が不正: %', v_row;
  END IF;
  IF v_row ? 'user_twitch_id' OR v_row ? 'card_id' THEN
    RAISE EXCEPTION 'allowlist 外の内部 id が返っている: %', v_row;
  END IF;

  -- ② 使用チャネルポイント（all）: b(600) → a(300, 直近) → d(300, 10日前) → e → f
  SELECT string_agg(e->>'username', ',' ORDER BY (e->>'rank')::INTEGER)
  INTO v_names FROM jsonb_array_elements(v_all->'by_points') e;
  IF v_names <> 'viewerB,viewerA,viewerD,viewerE,viewerF' THEN
    RAISE EXCEPTION 'by_points(all) の並びが不正: %', v_names;
  END IF;
  IF (v_all->'by_points'->0->>'total_points')::BIGINT <> 600 THEN
    RAISE EXCEPTION 'by_points 先頭の points が不正: %', v_all->'by_points'->0;
  END IF;
  -- N連の reward_cost が二重計上されていないこと（a は 3 枚で 300pt）。
  IF (v_all->'by_points'->1->>'total_points')::BIGINT <> 300 THEN
    RAISE EXCEPTION 'N連のポイントが二重計上されている: %', v_all->'by_points'->1;
  END IF;

  -- ③ 蒐集カード数: 所持ベースで period の影響を受けない。a(2種) → b(1種)。
  SELECT string_agg(e->>'username', ',' ORDER BY (e->>'rank')::INTEGER)
  INTO v_names FROM jsonb_array_elements(v_all->'by_unique') e;
  IF v_names <> 'viewerA,viewerB' THEN
    RAISE EXCEPTION 'by_unique の並びが不正: %', v_names;
  END IF;
  IF (v_all->'by_unique'->0->>'unique_count')::INTEGER <> 2
     OR (v_all->'by_unique'->0->>'total_cards')::INTEGER <> 2 THEN
    RAISE EXCEPTION 'by_unique の所持数が不正: %', v_all->'by_unique'->0;
  END IF;
  SELECT string_agg(e->>'username', ',' ORDER BY (e->>'rank')::INTEGER)
  INTO v_names FROM jsonb_array_elements(v_week->'by_unique') e;
  IF v_names <> 'viewerA,viewerB' THEN
    RAISE EXCEPTION 'by_unique が period の影響を受けていないべき: %', v_names;
  END IF;

  -- ④ 人気カード（all）: card2(5) → card1(4) → card3(3)
  SELECT string_agg(e->>'card_name', ',' ORDER BY (e->>'rank')::INTEGER)
  INTO v_names FROM jsonb_array_elements(v_all->'popular_cards') e;
  IF v_names <> 'CR Card Two,CR Card One,CR Card Three' THEN
    RAISE EXCEPTION 'popular_cards(all) の並びが不正: %', v_names;
  END IF;
  IF (v_all->'popular_cards'->0->>'actual_count')::INTEGER <> 5
     OR (v_all->'popular_cards'->0->>'drawer_count')::INTEGER <> 3 THEN
    RAISE EXCEPTION 'popular_cards 先頭行の件数が不正: %', v_all->'popular_cards'->0;
  END IF;
  IF v_all->'popular_cards'->0 ? 'card_id' THEN
    RAISE EXCEPTION 'popular_cards に card_id が返っている: %', v_all->'popular_cards'->0;
  END IF;

  -- period=7d: 10日前・2026-10-01 の行が落ち、レイドガチャ・本人・BOT も落ちる。
  SELECT string_agg(e->>'username', ',' ORDER BY (e->>'rank')::INTEGER)
  INTO v_names FROM jsonb_array_elements(v_week->'by_count') e;
  IF v_names <> 'viewerA,viewerB' THEN
    RAISE EXCEPTION 'by_count(7d) の並びが不正: %', v_names;
  END IF;
  SELECT string_agg(e->>'username', ',' ORDER BY (e->>'rank')::INTEGER)
  INTO v_names FROM jsonb_array_elements(v_week->'by_points') e;
  IF v_names <> 'viewerA,viewerB' THEN
    RAISE EXCEPTION 'by_points(7d) の並びが不正: %', v_names;
  END IF;
  IF (v_week->'by_points'->0->>'total_points')::BIGINT <> 300
     OR (v_week->'by_points'->1->>'total_points')::BIGINT <> 100 THEN
    RAISE EXCEPTION 'by_points(7d) の値が不正: %', v_week->'by_points';
  END IF;
  SELECT string_agg(e->>'card_name', ',' ORDER BY (e->>'rank')::INTEGER)
  INTO v_names FROM jsonb_array_elements(v_week->'popular_cards') e;
  IF v_names <> 'CR Card One,CR Card Two' THEN
    RAISE EXCEPTION 'popular_cards(7d) の並びが不正: %', v_names;
  END IF;

  -- metric_labels の4部門が揃っていること（docich が文言を二重管理しない契約）。
  IF (v_all->'metric_labels') ? 'by_count' IS NOT TRUE
     OR (v_all->'metric_labels') ? 'by_points' IS NOT TRUE
     OR (v_all->'metric_labels') ? 'by_unique' IS NOT TRUE
     OR (v_all->'metric_labels') ? 'popular_cards' IS NOT TRUE THEN
    RAISE EXCEPTION 'metric_labels が揃っていない: %', v_all->'metric_labels';
  END IF;
END $$;

-- 不正な period / limit は fail-closed（例外）であることを確認する。
DO $$
BEGIN
  BEGIN
    PERFORM public.get_card_ranking('50000000-0000-4000-8000-000000000001', 'lifetime', 10);
    RAISE EXCEPTION '不正な period が拒否されていない';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = '不正な period が拒否されていない' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.get_card_ranking('50000000-0000-4000-8000-000000000001', 'all', 0);
    RAISE EXCEPTION '不正な limit が拒否されていない';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = '不正な limit が拒否されていない' THEN RAISE; END IF;
  END;
END $$;

-- 空の配信者でも空配列（null ではなく）を返す。
DO $$
DECLARE
  v_empty JSONB;
BEGIN
  v_empty := public.get_card_ranking('50000000-0000-4000-8000-0000000000ff', 'all', 10);
  IF jsonb_typeof(v_empty->'by_count') <> 'array'
     OR jsonb_array_length(v_empty->'by_count') <> 0
     OR jsonb_array_length(v_empty->'by_points') <> 0
     OR jsonb_array_length(v_empty->'by_unique') <> 0
     OR jsonb_array_length(v_empty->'popular_cards') <> 0 THEN
    RAISE EXCEPTION '空の配信者に null が返った: %', v_empty;
  END IF;
END $$;
