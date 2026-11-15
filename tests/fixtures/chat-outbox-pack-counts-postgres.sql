\set ON_ERROR_STOP on

-- Issue #2045: チャット通知のパック単位プレースホルダー {packUnique}/{packAll} 用に、
-- chat_notification_outbox の BEFORE INSERT trigger（zz_snapshot_chat_outbox_pack_counts /
-- snapshot_chat_outbox_pack_counts）が payload.chatSnapshot.packCounts を保存する契約を
-- 実PostgreSQLで検証する。SQL文字列テストでは三値論理・jsonb結合・権限を検証できないため、
-- migration適用済みのCI DBへ直接INSERTしてtriggerの実挙動を確かめる。
--
-- 検証する契約:
--   1. スナップショットされた単発/N連テンプレートのどちらかに {packUnique} or {packAll}
--      がある → 当選カードが属する各パックについて {unique, all} を保存する。
--   2. packKey は payload 側 collection_name（空/NULL は __default__）。
--   3. unique は「視聴者が所持する有効カードの種類数（パック内）」、
--      all は「パックの有効カード総数」。is_active=false は両方で除外。
--   4. 両テンプレートがpackプレースホルダーを使わない → packCounts を書かない
--      （利用しない配信者のガチャコストを増やさない）。
--   5. migration/fixture由来の最小payloadは壊さず素通りさせる（fail-open）。

INSERT INTO public.streamers (
  id, twitch_user_id, twitch_username, twitch_display_name,
  chat_announcement_enabled
) VALUES (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'pack_counts_bc', 'pack_counts_bc', 'Pack Counts BC', true
);

-- cards:
--   'CI Pack'    : PackOne(active) / PackTwo(active)
--   未分類       : Free(active) / FreeInactive(inactive)
--   'Empty Pack' : InactiveOnly(inactive) — 有効カード0枚のパック
INSERT INTO public.cards (
  id, streamer_id, name, rarity, drop_rate, is_active, collection_name
) VALUES
  (
    'cc000001-0000-4000-8000-000000000001',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'PackOne', 'common', 0.3, true, 'CI Pack'
  ),
  (
    'cc000002-0000-4000-8000-000000000002',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'PackTwo', 'common', 0.3, true, 'CI Pack'
  ),
  (
    'cc000003-0000-4000-8000-000000000003',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'Free', 'common', 0.3, true, NULL
  ),
  (
    'cc000004-0000-4000-8000-000000000004',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'FreeInactive', 'common', 0.3, false, NULL
  ),
  (
    'cc000005-0000-4000-8000-000000000005',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'InactiveOnly', 'common', 0.3, false, 'Empty Pack'
  );

INSERT INTO public.users (twitch_user_id, twitch_username, twitch_display_name)
VALUES ('pack-counts-viewer', 'Pack Counts Viewer', 'Pack Counts Viewer');

-- 視聴者の所持: CI Pack の PackOne（有効）+ 未分類の FreeInactive（無効）。
-- packCounts.unique の「is_active=true の種類数のみ」境界を検証するため、
-- 無効カードも所持させておく（集計から除外されるべき）。
INSERT INTO public.user_cards (user_id, card_id)
SELECT users.id, seeded.card_id
FROM public.users
JOIN (
  VALUES
    ('pack-counts-viewer', 'cc000001-0000-4000-8000-000000000001'::uuid),
    ('pack-counts-viewer', 'cc000004-0000-4000-8000-000000000004'::uuid)
) AS seeded(twitch_user_id, card_id) ON seeded.twitch_user_id = users.twitch_user_id;

-- Case 1: 単発テンプレートが {packUnique}/{packAll} を使う → packCounts を保存する。
-- 当選カードは 'CI Pack' のカードと未分類カードの2枚 → 両パックのキーが必要。
INSERT INTO public.chat_notification_outbox (
  batch_id, payload, expected_draw_count, assembled_draw_count
) VALUES (
  'pack-counts-ci-1',
  jsonb_build_object(
    'batchId', 'pack-counts-ci-1',
    'broadcasterTwitchUserId', 'pack_counts_bc',
    'userId', 'pack-counts-viewer',
    'streamer', jsonb_build_object(
      'id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'chat_announcement_enabled', true,
      'chat_announcement_template', 'pack={packUnique}/{packAll}',
      'chat_announcement_multi_template', NULL,
      'chat_announcement_multi_show_cards', true,
      'default_card_pack_name', NULL
    ),
    'gachaResult', jsonb_build_object(
      'type', 'gacha',
      'card', jsonb_build_object(
        'id', 'cc000001-0000-4000-8000-000000000001',
        'name', 'PackOne', 'rarity', 'common', 'drop_rate', 0.3,
        'collection_name', 'CI Pack'
      ),
      'cards', jsonb_build_array(
        jsonb_build_object(
          'id', 'cc000001-0000-4000-8000-000000000001',
          'collection_name', 'CI Pack'
        ),
        jsonb_build_object(
          'id', 'cc000003-0000-4000-8000-000000000003',
          'collection_name', NULL
        ),
        jsonb_build_object(
          'id', 'cc000005-0000-4000-8000-000000000005',
          'collection_name', 'Empty Pack'
        )
      ),
      'userTwitchUsername', 'Pack Counts Viewer'
    ),
    'chatSnapshot', jsonb_build_object(
      'cardCount', 1, 'uniqueCount', 2, 'allCount', 3,
      'newCardNames', '[]'::jsonb, 'newCardNamesResolved', true
    )
  ),
  3, 3
);

-- Case 2: N連テンプレート側だけが {packAll} を使う場合も集計する
-- （単発テンプレートが未使用でも N連 individual/summary 再生で必要になる）。
INSERT INTO public.chat_notification_outbox (
  batch_id, payload, expected_draw_count, assembled_draw_count
) VALUES (
  'pack-counts-ci-2',
  jsonb_build_object(
    'batchId', 'pack-counts-ci-2',
    'broadcasterTwitchUserId', 'pack_counts_bc',
    'userId', 'pack-counts-viewer',
    'streamer', jsonb_build_object(
      'id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'chat_announcement_enabled', true,
      'chat_announcement_template', '@{user} got {card}',
      'chat_announcement_multi_template', 'pack all={packAll}',
      'chat_announcement_multi_show_cards', true,
      'default_card_pack_name', NULL
    ),
    'gachaResult', jsonb_build_object(
      'type', 'gacha',
      'card', jsonb_build_object(
        'id', 'cc000002-0000-4000-8000-000000000002',
        'name', 'PackTwo', 'rarity', 'common', 'drop_rate', 0.3,
        'collection_name', 'CI Pack'
      ),
      'cards', jsonb_build_array(
        jsonb_build_object(
          'id', 'cc000002-0000-4000-8000-000000000002',
          'collection_name', 'CI Pack'
        )
      ),
      'userTwitchUsername', 'Pack Counts Viewer'
    ),
    'chatSnapshot', jsonb_build_object(
      'cardCount', 1, 'uniqueCount', 2, 'allCount', 3,
      'newCardNames', '[]'::jsonb, 'newCardNamesResolved', true
    )
  ),
  1, 1
);

-- Case 3: 両テンプレートともpackプレースホルダーを使わない → packCounts を書かない。
INSERT INTO public.chat_notification_outbox (
  batch_id, payload, expected_draw_count, assembled_draw_count
) VALUES (
  'pack-counts-ci-3',
  jsonb_build_object(
    'batchId', 'pack-counts-ci-3',
    'broadcasterTwitchUserId', 'pack_counts_bc',
    'userId', 'pack-counts-viewer',
    'streamer', jsonb_build_object(
      'id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'chat_announcement_enabled', true,
      'chat_announcement_template', '@{user} got {card} {unique}/{all}',
      'chat_announcement_multi_template', '@{user} got {cards}',
      'chat_announcement_multi_show_cards', true,
      'default_card_pack_name', NULL
    ),
    'gachaResult', jsonb_build_object(
      'type', 'gacha',
      'card', jsonb_build_object(
        'id', 'cc000001-0000-4000-8000-000000000001',
        'name', 'PackOne', 'rarity', 'common', 'drop_rate', 0.3,
        'collection_name', 'CI Pack'
      ),
      'cards', jsonb_build_array(
        jsonb_build_object(
          'id', 'cc000001-0000-4000-8000-000000000001',
          'collection_name', 'CI Pack'
        )
      ),
      'userTwitchUsername', 'Pack Counts Viewer'
    ),
    'chatSnapshot', jsonb_build_object(
      'cardCount', 1, 'uniqueCount', 2, 'allCount', 3,
      'newCardNames', '[]'::jsonb, 'newCardNamesResolved', true
    )
  ),
  1, 1
);

-- Case 4: packプレースホルダー入りテンプレートでも、migration/fixture由来の
-- 最小payload（gachaResult/chatSnapshot 無し）は壊さず素通りさせる。
INSERT INTO public.chat_notification_outbox (
  batch_id, payload, expected_draw_count, assembled_draw_count
) VALUES (
  'pack-counts-ci-4',
  jsonb_build_object(
    'streamer', jsonb_build_object(
      'id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'chat_announcement_template', 'pack={packUnique}/{packAll}'
    )
  ),
  1, 1
);

DO $$
BEGIN
  -- Case 1: packCounts が期待どおり保存される。
  --   'CI Pack'    : unique=1（PackOneのみ所持）, all=2（PackOne/PackTwo）
  --   '__default__': unique=0（FreeInactiveはis_active=falseで除外）, all=1（Freeのみ）
  --   'Empty Pack' : unique=0, all=0（有効カード0枚でも当選パックのキーは出す）
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_notification_outbox
    WHERE batch_id = 'pack-counts-ci-1'
      AND payload #> '{chatSnapshot,packCounts}' =
        '{
          "CI Pack": {"unique": 1, "all": 2},
          "__default__": {"unique": 0, "all": 1},
          "Empty Pack": {"unique": 0, "all": 0}
        }'::jsonb
  ) THEN
    RAISE EXCEPTION 'packCounts not stored as expected (batch pack-counts-ci-1): %',
      (SELECT payload #> '{chatSnapshot,packCounts}'
         FROM public.chat_notification_outbox WHERE batch_id = 'pack-counts-ci-1');
  END IF;

  -- Case 2: multiテンプレート側だけの {packAll} でも集計される。
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_notification_outbox
    WHERE batch_id = 'pack-counts-ci-2'
      AND payload #> '{chatSnapshot,packCounts}' =
        '{"CI Pack": {"unique": 1, "all": 2}}'::jsonb
  ) THEN
    RAISE EXCEPTION 'packCounts not stored for multi-template placeholder (batch pack-counts-ci-2): %',
      (SELECT payload #> '{chatSnapshot,packCounts}'
         FROM public.chat_notification_outbox WHERE batch_id = 'pack-counts-ci-2');
  END IF;

  -- Case 3: 未使用時は packCounts キー自体を書かない。
  IF EXISTS (
    SELECT 1 FROM public.chat_notification_outbox
    WHERE batch_id = 'pack-counts-ci-3'
      AND payload #> '{chatSnapshot,packCounts}' IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'packCounts must not be stored when templates do not use pack placeholders';
  END IF;

  -- Case 4: 最小payloadは trigger で改変されない（payloadがそのまま残る）。
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_notification_outbox
    WHERE batch_id = 'pack-counts-ci-4'
      AND payload = jsonb_build_object(
        'streamer', jsonb_build_object(
          'id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          'chat_announcement_template', 'pack={packUnique}/{packAll}'
        )
      )
  ) THEN
    RAISE EXCEPTION 'minimal payload was modified by pack counts trigger';
  END IF;

  RAISE NOTICE 'chat outbox packCounts trigger fixture: all cases passed';
END $$;
