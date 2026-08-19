\set ON_ERROR_STOP on

-- PR #1032 Auto Reviewの必須指摘: db/planetscale/migrations/
-- 20260819120000_exclude_streamer_and_bot_from_redemption_rankings.sql の
-- 追加テストはSQLファイルへの正規表現マッチのみで、以下は未検証だった。
--   - trg_sync_channel_point_usage_stat_bot_account のDELETE時（BOT連携解除の
--     実経路 disconnectBotAccountPg は物理DELETE）に集計行が復帰すること
--   - refresh_channel_point_usage_stat の早期DELETE+RETURN（除外対象の自己修復）
--   - channel_point_usage_stats を直接壊す旧データに対する一回限りのバックフィルの
--     冪等性・対象範囲
-- CIのPostgreSQL 17へ本migrationまで適用した後、このfixtureで実際のトリガー・
-- 関数を実行して検証する（add-card-trading-postgres.sql等と同じ方式）。

INSERT INTO public.streamers (
  id, twitch_user_id, twitch_username, twitch_display_name
) VALUES
  (
    '40000000-0000-4000-8000-000000000001',
    'rrx-streamer-1-self', 'rrx-streamer-1', 'RRX Streamer 1'
  ),
  (
    -- system BOTのDELETE時に「全配信者ぶん再集計」される経路(3項参照)を
    -- 検証するための2人目の配信者。
    '40000000-0000-4000-8000-000000000002',
    'rrx-streamer-2-self', 'rrx-streamer-2', 'RRX Streamer 2'
  );

INSERT INTO public.cards (id, streamer_id, name, rarity, drop_rate, is_active)
VALUES
  (
    '40000000-0000-4000-8000-0000000000c1',
    '40000000-0000-4000-8000-000000000001',
    'RRX Card S1', 'common', 0.5, true
  ),
  (
    '40000000-0000-4000-8000-0000000000c2',
    '40000000-0000-4000-8000-000000000002',
    'RRX Card S2', 'common', 0.5, true
  );

-- ---------------------------------------------------------------------------
-- 1) 通常視聴者: 単発1回 + N連1回(3枚)。gacha_historyへのINSERTは
--    trg_sync_channel_point_usage_stat が都度refresh_channel_point_usage_stat
--    を呼ぶため、fixture側でRPCを明示的に叩かなくても集計は自動反映される。
-- ---------------------------------------------------------------------------
INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id,
  redeemed_at, event_id, reward_cost, reward_id
) VALUES
  (
    '40000000-0000-4000-8000-0000000000a1',
    'rrx-viewer-single', 'viewer_single',
    '40000000-0000-4000-8000-0000000000c1', '40000000-0000-4000-8000-000000000001',
    '2026-08-01 00:00:00+00', 'rrx-evt-single', 100, 'reward-single'
  ),
  (
    -- N連(3枚)の1枚目: reward_costを持つ
    '40000000-0000-4000-8000-0000000000a2',
    'rrx-viewer-multi', 'viewer_multi',
    '40000000-0000-4000-8000-0000000000c1', '40000000-0000-4000-8000-000000000001',
    '2026-08-02 00:00:00+00', 'rrx-evt-multi-1', 150, 'reward-multi'
  ),
  (
    -- N連の2枚目: reward_costはNULL(Twitch EventSubの仕様どおり)、reward_idは
    -- 1枚目と同じ値がforwardされる。
    '40000000-0000-4000-8000-0000000000a3',
    'rrx-viewer-multi', 'viewer_multi',
    '40000000-0000-4000-8000-0000000000c1', '40000000-0000-4000-8000-000000000001',
    '2026-08-02 00:00:01+00', 'rrx-evt-multi-2', NULL, 'reward-multi'
  ),
  (
    -- N連の3枚目
    '40000000-0000-4000-8000-0000000000a4',
    'rrx-viewer-multi', 'viewer_multi',
    '40000000-0000-4000-8000-0000000000c1', '40000000-0000-4000-8000-000000000001',
    '2026-08-02 00:00:02+00', 'rrx-evt-multi-3', NULL, 'reward-multi'
  );

DO $$
DECLARE
  v_single RECORD;
  v_multi RECORD;
BEGIN
  SELECT * INTO v_single FROM channel_point_usage_stats
  WHERE streamer_id = '40000000-0000-4000-8000-000000000001'
    AND user_twitch_id = 'rrx-viewer-single';
  IF NOT FOUND OR v_single.total_points <> 100 OR v_single.redemption_count <> 1 THEN
    RAISE EXCEPTION '単発引き換えの集計が不正: %', row_to_json(v_single);
  END IF;

  SELECT * INTO v_multi FROM channel_point_usage_stats
  WHERE streamer_id = '40000000-0000-4000-8000-000000000001'
    AND user_twitch_id = 'rrx-viewer-multi';
  -- 新述語の主目的: N連3枚がredemption_count=3として数えられる(旧述語では1)。
  -- total_pointsは1枚目のreward_costのみ(150)で、SUM(NULLは無視)は不変。
  IF NOT FOUND OR v_multi.total_points <> 150 OR v_multi.redemption_count <> 3 THEN
    RAISE EXCEPTION 'N連引き換えの集計が不正(過少カウント回帰の疑い): %', row_to_json(v_multi);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) 配信者本人の引き換え: is_redemption_ranking_excludedがtrueになり、
--    refresh_channel_point_usage_statの早期DELETE+RETURNにより行が作られない。
-- ---------------------------------------------------------------------------
INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id,
  redeemed_at, event_id, reward_cost, reward_id
) VALUES (
  '40000000-0000-4000-8000-0000000000a5',
  'rrx-streamer-1-self', 'rrx-streamer-1',
  '40000000-0000-4000-8000-0000000000c1', '40000000-0000-4000-8000-000000000001',
  '2026-08-03 00:00:00+00', 'rrx-evt-self', 200, 'reward-self'
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM channel_point_usage_stats
    WHERE streamer_id = '40000000-0000-4000-8000-000000000001'
      AND user_twitch_id = 'rrx-streamer-1-self'
  ) THEN
    RAISE EXCEPTION '配信者本人の引き換えがランキングに混入している';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) 配信者固有BOT: 登録中は除外、連携解除(物理DELETE)で復帰する。
--    disconnectBotAccountPg(src/app/api/streamer/settings/route.ts)が
--    twitch_bot_accounts行を物理DELETEする実経路を、このDELETE文で再現する。
-- ---------------------------------------------------------------------------
INSERT INTO public.twitch_bot_accounts (
  id, owner_type, streamer_id, twitch_user_id,
  twitch_access_token, twitch_refresh_token, twitch_token_expires_at
) VALUES (
  '40000000-0000-4000-8000-0000000000b1',
  'streamer', '40000000-0000-4000-8000-000000000001', 'rrx-bot-streamer',
  'dummy-access', 'dummy-refresh', '2099-01-01 00:00:00+00'
);

INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id,
  redeemed_at, event_id, reward_cost, reward_id
) VALUES (
  '40000000-0000-4000-8000-0000000000a6',
  'rrx-bot-streamer', 'rrx-bot-streamer',
  '40000000-0000-4000-8000-0000000000c1', '40000000-0000-4000-8000-000000000001',
  '2026-08-04 00:00:00+00', 'rrx-evt-bot-streamer', 300, 'reward-bot-streamer'
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM channel_point_usage_stats
    WHERE streamer_id = '40000000-0000-4000-8000-000000000001'
      AND user_twitch_id = 'rrx-bot-streamer'
  ) THEN
    RAISE EXCEPTION '配信者固有BOTの引き換えがランキングに混入している(連携中)';
  END IF;
END $$;

-- 連携解除(物理DELETE)。trg_sync_channel_point_usage_stat_bot_accountの
-- DELETE分岐がrefresh_channel_point_usage_statを再実行し、gacha_historyには
-- 既に存在するこのユーザーの行を今度は除外対象ではないものとして拾うはず。
DELETE FROM public.twitch_bot_accounts WHERE id = '40000000-0000-4000-8000-0000000000b1';

DO $$
DECLARE
  v_restored RECORD;
BEGIN
  SELECT * INTO v_restored FROM channel_point_usage_stats
  WHERE streamer_id = '40000000-0000-4000-8000-000000000001'
    AND user_twitch_id = 'rrx-bot-streamer';
  IF NOT FOUND OR v_restored.total_points <> 300 OR v_restored.redemption_count <> 1 THEN
    RAISE EXCEPTION 'BOT連携解除後にランキングが復帰していない(自己修復の回帰): %', row_to_json(v_restored);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) 共有system BOT: streamer_idを問わず全配信者で除外され、連携解除で
--    「全配信者ぶん」復帰する(sync_channel_point_usage_stat_for_bot_accountの
--    OLD.owner_type='system'分岐: FROM streamers s WHERE ... で全件展開)。
-- ---------------------------------------------------------------------------
INSERT INTO public.twitch_bot_accounts (
  id, owner_type, streamer_id, twitch_user_id,
  twitch_access_token, twitch_refresh_token, twitch_token_expires_at
) VALUES (
  '40000000-0000-4000-8000-0000000000b2',
  'system', NULL, 'rrx-bot-shared',
  'dummy-access', 'dummy-refresh', '2099-01-01 00:00:00+00'
);

INSERT INTO public.gacha_history (
  id, user_twitch_id, user_twitch_username, card_id, streamer_id,
  redeemed_at, event_id, reward_cost, reward_id
) VALUES
  (
    '40000000-0000-4000-8000-0000000000a7',
    'rrx-bot-shared', 'rrx-bot-shared',
    '40000000-0000-4000-8000-0000000000c1', '40000000-0000-4000-8000-000000000001',
    '2026-08-05 00:00:00+00', 'rrx-evt-bot-shared-s1', 400, 'reward-bot-shared-s1'
  ),
  (
    '40000000-0000-4000-8000-0000000000a8',
    'rrx-bot-shared', 'rrx-bot-shared',
    '40000000-0000-4000-8000-0000000000c2', '40000000-0000-4000-8000-000000000002',
    '2026-08-05 00:00:00+00', 'rrx-evt-bot-shared-s2', 500, 'reward-bot-shared-s2'
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM channel_point_usage_stats WHERE user_twitch_id = 'rrx-bot-shared'
  ) THEN
    RAISE EXCEPTION '共有system BOTの引き換えがいずれかの配信者のランキングに混入している(連携中)';
  END IF;
END $$;

DELETE FROM public.twitch_bot_accounts WHERE id = '40000000-0000-4000-8000-0000000000b2';

DO $$
DECLARE
  v_s1 RECORD;
  v_s2 RECORD;
BEGIN
  -- Auto Review必須指摘対応: plpgsqlのFOUNDは直前のSELECT INTO(v_s2)だけを
  -- 指すため、「NOT FOUND OR v_s1...」ではv_s1側が未復帰でもFOUND=true
  -- (v_s2は見つかる)かつv_s1.total_pointsがNULLで比較がNULLになり、
  -- OR全体がNULLとなってIFが成立せず例外が発生しない(この検証が実質no-opに
  -- なっていた)。IS DISTINCT FROMはNULL同士・NULLと非NULLのどちらでもtrueを
  -- 返すため、レコードが見つからない場合も含めて確実に検知できる。
  SELECT * INTO v_s1 FROM channel_point_usage_stats
  WHERE streamer_id = '40000000-0000-4000-8000-000000000001' AND user_twitch_id = 'rrx-bot-shared';
  SELECT * INTO v_s2 FROM channel_point_usage_stats
  WHERE streamer_id = '40000000-0000-4000-8000-000000000002' AND user_twitch_id = 'rrx-bot-shared';
  IF v_s1.total_points IS DISTINCT FROM 400 OR v_s1.redemption_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '共有system BOT解除後、配信者1側が復帰していない: %', row_to_json(v_s1);
  END IF;
  IF v_s2.total_points IS DISTINCT FROM 500 OR v_s2.redemption_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '共有system BOT解除後、配信者2側が復帰していない(全配信者展開の回帰): %', row_to_json(v_s2);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5) 一回限りバックフィルの冪等性: channel_point_usage_statsを直接壊し
--    (移行前の不正確な既存データを模す)、migration本体と同じ2文
--    (DELETE除外対象 → 新述語で再集計INSERT...ON CONFLICT)を再実行して、
--    (a) 正しい値へ是正され、(b) 2回目の実行で結果が変化しない(冪等)ことを
--    確認する。OFFSET 0フェンスの実行計画形状そのもの(EXPLAINでの確認)は
--    migration側のコメントで実測済みのためここでは対象にせず、このfixtureは
--    「壊れたデータが正しい値へ収束し、再実行しても壊れない」という結果面の
--    正しさに限定する。
-- ---------------------------------------------------------------------------

-- 5a) 配信者本人ぶんの不正な残存行(移行前バグの典型例)を直接投入する。
INSERT INTO public.channel_point_usage_stats (
  streamer_id, user_twitch_id, username, total_points, redemption_count, last_redeemed_at
) VALUES (
  '40000000-0000-4000-8000-000000000001', 'rrx-streamer-1-self', 'stale', 999, 9, now()
);

-- 5b) 単発視聴者ぶんの値を書き換えて壊す(旧述語による過少カウントを模す)。
UPDATE public.channel_point_usage_stats
SET total_points = 1, redemption_count = 1
WHERE streamer_id = '40000000-0000-4000-8000-000000000001'
  AND user_twitch_id = 'rrx-viewer-single';

-- migration本体(20260819120000_...sql)の「6) 一回限りのバックフィル」節と
-- 同一のSQL(コピー)を1回目として実行する。
DELETE FROM channel_point_usage_stats s
WHERE is_redemption_ranking_excluded(s.streamer_id, s.user_twitch_id);

INSERT INTO channel_point_usage_stats (
  streamer_id, user_twitch_id, username,
  total_points, redemption_count, last_redeemed_at
)
SELECT
  agg.streamer_id, agg.user_twitch_id, agg.username,
  agg.total_points, agg.redemption_count, agg.last_redeemed_at
FROM (
  SELECT
    h.streamer_id,
    h.user_twitch_id,
    COALESCE(MAX(h.user_twitch_username), h.user_twitch_id) AS username,
    COALESCE(SUM(h.reward_cost), 0)::BIGINT AS total_points,
    COUNT(*)::INTEGER AS redemption_count,
    MAX(h.redeemed_at) AS last_redeemed_at
  FROM gacha_history h
  WHERE h.reward_cost > 0 OR h.reward_id IS NOT NULL
  GROUP BY h.streamer_id, h.user_twitch_id
  OFFSET 0
) agg
WHERE NOT is_redemption_ranking_excluded(agg.streamer_id, agg.user_twitch_id)
ON CONFLICT (streamer_id, user_twitch_id) DO UPDATE SET
  username = EXCLUDED.username,
  total_points = EXCLUDED.total_points,
  redemption_count = EXCLUDED.redemption_count,
  last_redeemed_at = EXCLUDED.last_redeemed_at,
  updated_at = NOW();

DO $$
DECLARE
  v_single RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM channel_point_usage_stats
    WHERE streamer_id = '40000000-0000-4000-8000-000000000001'
      AND user_twitch_id = 'rrx-streamer-1-self'
  ) THEN
    RAISE EXCEPTION 'バックフィル1回目後も配信者本人の不正な行が残っている';
  END IF;

  SELECT * INTO v_single FROM channel_point_usage_stats
  WHERE streamer_id = '40000000-0000-4000-8000-000000000001'
    AND user_twitch_id = 'rrx-viewer-single';
  IF NOT FOUND OR v_single.total_points <> 100 OR v_single.redemption_count <> 1 THEN
    RAISE EXCEPTION 'バックフィル1回目で壊れた単発視聴者の値が是正されていない: %', row_to_json(v_single);
  END IF;
END $$;

-- 冪等性確認用に1回目の全行スナップショットを保存する。
CREATE TEMP TABLE rrx_backfill_snapshot AS
SELECT streamer_id, user_twitch_id, username, total_points, redemption_count, last_redeemed_at
FROM channel_point_usage_stats;

-- 同一の2文を2回目として再実行する。
DELETE FROM channel_point_usage_stats s
WHERE is_redemption_ranking_excluded(s.streamer_id, s.user_twitch_id);

INSERT INTO channel_point_usage_stats (
  streamer_id, user_twitch_id, username,
  total_points, redemption_count, last_redeemed_at
)
SELECT
  agg.streamer_id, agg.user_twitch_id, agg.username,
  agg.total_points, agg.redemption_count, agg.last_redeemed_at
FROM (
  SELECT
    h.streamer_id,
    h.user_twitch_id,
    COALESCE(MAX(h.user_twitch_username), h.user_twitch_id) AS username,
    COALESCE(SUM(h.reward_cost), 0)::BIGINT AS total_points,
    COUNT(*)::INTEGER AS redemption_count,
    MAX(h.redeemed_at) AS last_redeemed_at
  FROM gacha_history h
  WHERE h.reward_cost > 0 OR h.reward_id IS NOT NULL
  GROUP BY h.streamer_id, h.user_twitch_id
  OFFSET 0
) agg
WHERE NOT is_redemption_ranking_excluded(agg.streamer_id, agg.user_twitch_id)
ON CONFLICT (streamer_id, user_twitch_id) DO UPDATE SET
  username = EXCLUDED.username,
  total_points = EXCLUDED.total_points,
  redemption_count = EXCLUDED.redemption_count,
  last_redeemed_at = EXCLUDED.last_redeemed_at,
  updated_at = NOW();

DO $$
DECLARE
  v_added INTEGER;
  v_removed INTEGER;
BEGIN
  -- updated_atはON CONFLICT DO UPDATEで毎回NOW()に更新されるため比較対象から
  -- 除外し、導出値(username/total_points/redemption_count/last_redeemed_at)
  -- だけが2回の実行で完全一致することを確認する(冪等性)。差集合を2方向とも
  -- 単一のスカラへ集約する(複数行をSELECT INTOへ渡すと先頭行だけが使われ
  -- 片方向の差分を見落とすため、2つのIF条件に分ける)。
  SELECT COUNT(*) INTO v_added FROM (
    SELECT streamer_id, user_twitch_id, username, total_points, redemption_count, last_redeemed_at
    FROM channel_point_usage_stats
    EXCEPT
    SELECT streamer_id, user_twitch_id, username, total_points, redemption_count, last_redeemed_at
    FROM rrx_backfill_snapshot
  ) diff_after;

  SELECT COUNT(*) INTO v_removed FROM (
    SELECT streamer_id, user_twitch_id, username, total_points, redemption_count, last_redeemed_at
    FROM rrx_backfill_snapshot
    EXCEPT
    SELECT streamer_id, user_twitch_id, username, total_points, redemption_count, last_redeemed_at
    FROM channel_point_usage_stats
  ) diff_before;

  IF v_added <> 0 OR v_removed <> 0 THEN
    RAISE EXCEPTION 'バックフィルが冪等でない(2回目の実行で値が変化した): added=%, removed=%', v_added, v_removed;
  END IF;
END $$;

DROP TABLE rrx_backfill_snapshot;
