-- Issue #784: get_gacha_drop_stats（排出率統計RPC）から手動ドロー(QA用)を除外する。
--
-- 背景: POST /api/gacha の手動ドロー(配信者が自チャンネルに対して行うQA用の
-- 動作確認ドロー、Issue #781でチャンネル所有者限定化済み)は execute_gacha_transaction
-- RPC 経由で実カードを付与し、gacha_history にも通常ドローと同じ形で記録される。
-- event_id は `manual:${crypto.randomUUID()}` 形式で一意に採番される
-- (src/app/api/gacha/route.ts の manualDrawEventId、Issue #661/migration 00076)。
--
-- NULL event_id の扱い(意図的): gacha_history.event_id は nullable であり
-- (migration 00001)、NULLを書き込んでいた唯一の経路は Issue #661 修正前の
-- 旧・手動ドローAPI(migration 00076ヘッダー参照。当時は eventId 引数を
-- 省略して呼び出しており、修正後は必ず `manual:<uuid>` を渡すようになった)。
-- `event_id NOT LIKE 'manual:%'` は NULL に対しては NULL(=WHEREでは偽)を
-- 返すため、これら旧式のNULL行も本migrationの除外条件で自動的に除外される。
-- これは実際の視聴者向け抽選ではない手動ドローの残骸であり、Issue #784の
-- 意図(手動ドローをdrop-rate統計から除く)に合致する正しい挙動である。
--
-- このQAドローが「実際の配信でどれだけの確率でカードが出たか」を見たい
-- drop-rate統計(get_gacha_drop_stats)に混入し、実際の視聴者向け抽選結果とは
-- 無関係なノイズとして total_draws / card_stats.actual_count・actual_rate /
-- drawers / rarity_stats を歪める。本migrationは gacha_history を参照する
-- 全ての集計箇所に `event_id NOT LIKE 'manual:%'` 条件を追加し、この統計RPCから
-- 手動ドロー分を除外する。
--
-- 除外しないもの(意図的、対象外):
--   - execute_gacha_transaction の発行数カウント(user_cards の COUNT、migration
--     00076/00069等)は本migrationでは一切変更しない。カウント対象は
--     user_cards(event_id列を持たない)であり、手動ドローも実カードを1枚
--     付与する以上、そのカウントから除外すると「発行上限N枚のカードが実際には
--     N枚しか存在しない」という物理的な保証が崩れる(手動ドローで規定枚数以上の
--     カード実体が生まれてしまう)。この設計判断はコード変更を伴わないため
--     Issue #784 側に記録する。
--   - get_card_owner_stats 等の「所持ユーザー」統計は対象外。所持は事実
--     (実際にそのカードを持っている)であり、入手経路が手動ドローかどうかに
--     関わらず除外しない。
--   - fetchChannelPointUsageStatsFromHistory（チャンネルポイント消費統計）は
--     手動ドローが reward_cost=NULL で記録されるため既存の `.gt("reward_cost", 0)`
--     条件で自動的に除外済みであり、変更不要(本migrationとは独立に確認済み)。
--
-- 関数シグネチャ・デフォルト引数は 00052 から不変(p_streamer_id, p_from_date,
-- p_limit_per_card DEFAULT 100 のまま)。00076のように呼び出し規約(引数の
-- 許容値)を変えるものではなく、CREATE OR REPLACE で関数の内部ロジックのみを
-- 差し替える。そのためアプリケーションコード側の変更は一切不要で、
-- 本migrationの適用タイミングと Cloudflare Workers 側のアプリデプロイの
-- 順序には依存関係がない(00076ヘッダーの「デプロイ順序の注意」とは対照的に、
-- 本migrationは適用前後どちらのタイミングでアプリが動いていても
-- 正常に動作し続ける)。
--
-- 本migrationは他のマイグレーション同様 forward-only (CREATE OR REPLACE の
-- みで down-migration は無い)。ロールバックが必要な場合は、除外条件を
-- 外した新しいmigrationを追加すること。
--
-- 集計ロジックそのもの(total_draws / card_stats の rate 計算 / drawer_agg /
-- rarity_stats の rarity_universe 統合)は 00052 から変更なし。変更点は
-- gacha_history を直接参照する4箇所への `event_id NOT LIKE 'manual:%'`
-- 条件の追加と、それに伴う covering index (20260713080000) の張り替え
-- (INCLUDE への event_id 追加、本ファイル末尾)の2点のみ。

CREATE OR REPLACE FUNCTION get_gacha_drop_stats(
  p_streamer_id UUID,
  p_from_date TIMESTAMPTZ,
  p_limit_per_card INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_draws BIGINT;
  v_total_weight NUMERIC;
  v_card_stats JSONB;
  v_rarity_stats JSONB;
BEGIN
  SELECT COUNT(*)::BIGINT
  INTO v_total_draws
  FROM gacha_history
  WHERE streamer_id = p_streamer_id
    AND redeemed_at >= p_from_date
    AND event_id NOT LIKE 'manual:%';

  SELECT COALESCE(SUM(drop_rate), 0)::NUMERIC
  INTO v_total_weight
  FROM cards
  WHERE streamer_id = p_streamer_id
    AND is_active = TRUE;

  -- カードごとに gacha_history を引き直す N+1 な LATERAL を避け、
  -- 期間内の履歴を一度だけ (card_id, user_twitch_id) で集計し、
  -- ウィンドウ関数で「カード内の引いた回数ランキング」を付与する。
  -- これにより gacha_history へのアクセスはカード数に依らず一定回数。
  WITH draw_counts AS (
    SELECT card_id, COUNT(*)::BIGINT AS draw_count
    FROM gacha_history
    WHERE streamer_id = p_streamer_id
      AND redeemed_at >= p_from_date
      AND event_id NOT LIKE 'manual:%'
    GROUP BY card_id
  ),
  drawer_agg AS (
    SELECT
      gh.card_id,
      gh.user_twitch_id,
      COALESCE(MAX(gh.user_twitch_username), gh.user_twitch_id) AS username,
      COUNT(*)::BIGINT AS draw_count,
      MAX(gh.redeemed_at) AS last_drawn_at
    FROM gacha_history gh
    WHERE gh.streamer_id = p_streamer_id
      AND gh.redeemed_at >= p_from_date
      AND gh.event_id NOT LIKE 'manual:%'
    GROUP BY gh.card_id, gh.user_twitch_id
  ),
  drawer_ranked AS (
    SELECT
      da.*,
      ROW_NUMBER() OVER (
        PARTITION BY da.card_id
        ORDER BY da.draw_count DESC, da.last_drawn_at DESC
      ) AS rn
    FROM drawer_agg da
  ),
  -- drawer_count はカード内の全ユニークユーザー数（打ち切り前）、
  -- drawers は rn <= p_limit_per_card のみを JSONB 化（上位N件）。
  drawer_by_card AS (
    SELECT
      dr.card_id,
      COUNT(*)::BIGINT AS drawer_count,
      jsonb_agg(
        jsonb_build_object(
          'user_twitch_id', dr.user_twitch_id,
          'username', dr.username,
          'draw_count', dr.draw_count,
          'last_drawn_at', dr.last_drawn_at
        )
        ORDER BY dr.draw_count DESC, dr.last_drawn_at DESC
      ) FILTER (WHERE dr.rn <= GREATEST(1, p_limit_per_card)) AS drawers
    FROM drawer_ranked dr
    GROUP BY dr.card_id
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'card_id', c.id,
      'card_name', c.name,
      'rarity', c.rarity,
      'image_url', c.image_url,
      'configured_rate', CASE
        WHEN v_total_weight > 0 THEN (c.drop_rate / v_total_weight) * 100
        ELSE 0
      END,
      'actual_count', COALESCE(dc.draw_count, 0),
      'actual_rate', CASE
        WHEN v_total_draws > 0 THEN (COALESCE(dc.draw_count, 0)::NUMERIC / v_total_draws) * 100
        ELSE 0
      END,
      'drawer_count', COALESCE(dbc.drawer_count, 0),
      'drawers', COALESCE(dbc.drawers, '[]'::JSONB)
    )
    ORDER BY c.rarity_order ASC, c.created_at DESC
  ), '[]'::JSONB)
  INTO v_card_stats
  FROM cards c
  LEFT JOIN draw_counts dc ON dc.card_id = c.id
  LEFT JOIN drawer_by_card dbc ON dbc.card_id = c.id
  WHERE c.streamer_id = p_streamer_id
    AND c.is_active = TRUE;

  WITH rarity_counts AS (
    SELECT c.rarity, COUNT(*)::BIGINT AS draw_count
    FROM gacha_history gh
    JOIN cards c ON c.id = gh.card_id
    WHERE gh.streamer_id = p_streamer_id
      AND gh.redeemed_at >= p_from_date
      AND gh.event_id NOT LIKE 'manual:%'
    GROUP BY c.rarity
  ),
  default_order AS (
    SELECT *
    FROM (VALUES
      ('legendary'::TEXT, 1),
      ('epic'::TEXT, 2),
      ('rare'::TEXT, 3),
      ('common'::TEXT, 4)
    ) AS r(rarity, sort_order)
  ),
  -- デフォルト4種（排出0でも常に表示）＋ 実際に排出されたカスタムレアリティ。
  -- カスタムは sort_order=5 でデフォルトの後ろ、名前順で安定整列する。
  rarity_universe AS (
    SELECT rarity, sort_order FROM default_order
    UNION
    SELECT rc.rarity, 5
    FROM rarity_counts rc
    WHERE rc.rarity NOT IN (SELECT rarity FROM default_order)
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'rarity', ru.rarity,
      'count', COALESCE(rc.draw_count, 0),
      'rate', CASE
        WHEN v_total_draws > 0 THEN (COALESCE(rc.draw_count, 0)::NUMERIC / v_total_draws) * 100
        ELSE 0
      END
    )
    ORDER BY ru.sort_order, ru.rarity
  )
  INTO v_rarity_stats
  FROM rarity_universe ru
  LEFT JOIN rarity_counts rc ON rc.rarity = ru.rarity;

  RETURN jsonb_build_object(
    'total_draws', v_total_draws,
    'card_stats', v_card_stats,
    'rarity_stats', v_rarity_stats
  );
END;
$$;

REVOKE ALL ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ, INTEGER) TO service_role;

-- インデックス張り替え(Issue #672 対策の維持):
-- 20260713080000 で追加した covering index
--   idx_gacha_history_streamer_redeemed_card_user
--     ON gacha_history(streamer_id, redeemed_at, card_id, user_twitch_id)
--     INCLUDE (user_twitch_username)
-- は #672 の statement timeout 対策として、上記4クエリの
-- streamer_id / redeemed_at 条件と card_id / user_twitch_id 集約を
-- index-only scan だけで完結させることを狙ったものだった。
-- しかし本migrationで追加した `event_id NOT LIKE 'manual:%'` 述語は
-- event_id の値そのものを評価する必要があり、event_id は上記INCLUDEに
-- 含まれていない。そのため述語評価のたびにインデックスエントリごとの
-- heap fetch (visibility checkを含む) が発生し、#672 で得た index-only
-- scan の効果が失われてしまう(実測: Postgres 17・約20万行で count
-- クエリの buffers が 168 → 3018 と約18倍に悪化)。
--
-- event_id を INCLUDE に追加してインデックスを張り替え、新しい述語も
-- 引き続き index-only scan の範囲内で評価できるようにする。
--
-- Supabase migrations はトランザクション内で適用されるため、
-- 20260713080000 と同様に CREATE INDEX CONCURRENTLY は使用しない。
-- DROP IF EXISTS → CREATE IF NOT EXISTS の組み合わせにより、
-- 初回適用(旧インデックスをこの定義に張り替える)・再適用(DROPが
-- 空振りしCREATEもIF NOT EXISTSでスキップされる)のどちらも安全。
DROP INDEX IF EXISTS idx_gacha_history_streamer_redeemed_card_user;
CREATE INDEX IF NOT EXISTS idx_gacha_history_streamer_redeemed_card_user
  ON gacha_history(streamer_id, redeemed_at, card_id, user_twitch_id)
  INCLUDE (user_twitch_username, event_id);
