-- 「カード別」統計タブ用: カード所持ユーザーを全期間で集計する累積テーブル。
--
-- 旧実装は getGachaStats() のたびに user_cards を最大1万件フェッチして
-- アプリ側で (card_id, user) ごとに集計していた。これは所持レコードが
-- 増えるほどDB I/O とアプリのメモリ負荷が線形に増大し、PostgREST の
-- 行上限（1万件）に達すると集計が欠落する問題もあった。
--
-- channel_point_usage_stats（00039）と同じ「トリガー維持の集計テーブル」
-- パターンを踏襲し、user_cards への INSERT/UPDATE/DELETE のたびに
-- 該当 (card_id, user) の1行だけを再集計する。読み取り時は
-- card_owner_stats を card_id で引くだけになり、DB負荷を大幅に下げる。
--
-- 既知の制約: users 行が削除されると user_cards は ON DELETE CASCADE で
-- 消えるが、その時点で users 行も消えているためトリガーから twitch_user_id
-- を解決できず、card_owner_stats に孤児行が残りうる。これは
-- channel_point_usage_stats と同じ best-effort な制約で、配信者向け
-- 分析用途では許容する（アカウント削除は稀で実害が小さいため）。

CREATE TABLE IF NOT EXISTS card_owner_stats (
  streamer_id UUID NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_twitch_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  owned_count INTEGER NOT NULL DEFAULT 0 CHECK (owned_count >= 0),
  last_obtained_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (streamer_id, card_id, user_twitch_id)
);

-- カード別の所持ランキング読み出し（owned_count 降順 → 取得日時降順）を
-- インデックスのみで解決するための複合インデックス。
CREATE INDEX IF NOT EXISTS idx_card_owner_stats_card_rank
  ON card_owner_stats(
    streamer_id,
    card_id,
    owned_count DESC,
    last_obtained_at DESC
  );

-- refresh_card_owner_stat はガチャ排出のたび（user_cards INSERT のホットパス）
-- に発火し、WHERE card_id=? AND user_id=? で COUNT(*)/MAX(obtained_at) する。
-- 00001 の単一列インデックス2本では BitmapAnd になり所持数が多いカード/
-- ユーザーで遅くなるため、複合インデックスでインデックスオンリースキャン化する
-- (00039 が gacha_history(streamer_id,user_twitch_id) 複合索引を用意したのと同様)。
CREATE INDEX IF NOT EXISTS idx_user_cards_user_card
  ON user_cards(user_id, card_id, obtained_at DESC);

-- 指定 (card_id, user_id) の所持状況を user_cards から再集計し、
-- card_owner_stats を1行だけ upsert/delete する。
CREATE OR REPLACE FUNCTION refresh_card_owner_stat(
  p_card_id UUID,
  p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_streamer_id UUID;
  v_twitch_user_id TEXT;
  v_username TEXT;
  v_display_name TEXT;
  v_owned_count INTEGER;
  v_last_obtained_at TIMESTAMPTZ;
BEGIN
  IF p_card_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT streamer_id INTO v_streamer_id
  FROM cards
  WHERE id = p_card_id;

  SELECT twitch_user_id, twitch_username, twitch_display_name
  INTO v_twitch_user_id, v_username, v_display_name
  FROM users
  WHERE id = p_user_id;

  -- カード or ユーザーが解決できない場合は集計不能なのでスキップ。
  IF v_streamer_id IS NULL OR v_twitch_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER, MAX(obtained_at)
  INTO v_owned_count, v_last_obtained_at
  FROM user_cards
  WHERE card_id = p_card_id
    AND user_id = p_user_id;

  IF v_owned_count = 0 THEN
    DELETE FROM card_owner_stats
    WHERE streamer_id = v_streamer_id
      AND card_id = p_card_id
      AND user_twitch_id = v_twitch_user_id;
    RETURN;
  END IF;

  INSERT INTO card_owner_stats (
    streamer_id,
    card_id,
    user_twitch_id,
    username,
    display_name,
    owned_count,
    last_obtained_at
  )
  VALUES (
    v_streamer_id,
    p_card_id,
    v_twitch_user_id,
    v_username,
    v_display_name,
    v_owned_count,
    v_last_obtained_at
  )
  ON CONFLICT (streamer_id, card_id, user_twitch_id) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    owned_count = EXCLUDED.owned_count,
    last_obtained_at = EXCLUDED.last_obtained_at,
    updated_at = NOW();
END;
$$;

-- user_cards の変更を card_owner_stats に反映するトリガー本体。
-- UPDATE で card_id/user_id が変わるケースも考慮し、OLD/NEW 双方を再集計する。
CREATE OR REPLACE FUNCTION sync_card_owner_stat()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM refresh_card_owner_stat(OLD.card_id, OLD.user_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM refresh_card_owner_stat(NEW.card_id, NEW.user_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_card_owner_stat ON user_cards;
CREATE TRIGGER trg_sync_card_owner_stat
AFTER INSERT OR UPDATE OR DELETE ON user_cards
FOR EACH ROW
EXECUTE FUNCTION sync_card_owner_stat();

-- 既存 user_cards からの初期バックフィル。
-- user_cards が大規模な場合に supabase db push の statement_timeout で
-- マイグレーション全体がロールバックされるのを防ぐ。マイグレーションは
-- トランザクション内なので SET LOCAL はこのトランザクション内に限定される。
-- ON CONFLICT DO UPDATE により再実行は冪等。
SET LOCAL statement_timeout = 0;

INSERT INTO card_owner_stats (
  streamer_id,
  card_id,
  user_twitch_id,
  username,
  display_name,
  owned_count,
  last_obtained_at
)
SELECT
  c.streamer_id,
  uc.card_id,
  u.twitch_user_id,
  MAX(u.twitch_username) AS username,
  MAX(u.twitch_display_name) AS display_name,
  COUNT(*)::INTEGER AS owned_count,
  MAX(uc.obtained_at) AS last_obtained_at
FROM user_cards uc
JOIN cards c ON c.id = uc.card_id
JOIN users u ON u.id = uc.user_id
GROUP BY c.streamer_id, uc.card_id, u.twitch_user_id
ON CONFLICT (streamer_id, card_id, user_twitch_id) DO UPDATE SET
  username = EXCLUDED.username,
  display_name = EXCLUDED.display_name,
  owned_count = EXCLUDED.owned_count,
  last_obtained_at = EXCLUDED.last_obtained_at,
  updated_at = NOW();

-- 「カード別」タブ用: 配信者のアクティブカードごとに所持ユーザーを返す。
-- 所持者が1人もいないカードも LEFT JOIN で表示する（排出率テーブルと同様、
-- カード一覧として欠落させない）。owners はカードごとに p_limit_per_card
-- 件で打ち切り、JSONB ペイロードが青天井に膨らむのを防ぐ。
CREATE OR REPLACE FUNCTION get_card_owner_stats(
  p_streamer_id UUID,
  p_limit_per_card INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_card_stats JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'card_id', c.id,
      'card_name', c.name,
      'rarity', c.rarity,
      'image_url', c.image_url,
      'owner_count', COALESCE(oc.owner_count, 0),
      'owners', COALESCE(ow.owners, '[]'::JSONB)
    )
    ORDER BY c.rarity_order ASC, c.created_at DESC
  ), '[]'::JSONB)
  INTO v_card_stats
  FROM cards c
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS owner_count
    FROM card_owner_stats s
    WHERE s.streamer_id = p_streamer_id
      AND s.card_id = c.id
  ) oc ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'user_twitch_id', t.user_twitch_id,
        'username', t.username,
        'display_name', t.display_name,
        'owned_count', t.owned_count,
        'last_obtained_at', t.last_obtained_at
      )
      ORDER BY t.owned_count DESC, t.last_obtained_at DESC
    ) AS owners
    FROM (
      SELECT
        s.user_twitch_id,
        s.username,
        s.display_name,
        s.owned_count,
        s.last_obtained_at
      FROM card_owner_stats s
      WHERE s.streamer_id = p_streamer_id
        AND s.card_id = c.id
      ORDER BY s.owned_count DESC, s.last_obtained_at DESC
      LIMIT GREATEST(1, p_limit_per_card)
    ) t
  ) ow ON TRUE
  WHERE c.streamer_id = p_streamer_id
    AND c.is_active = TRUE;

  RETURN jsonb_build_object('card_stats', v_card_stats);
END;
$$;

REVOKE ALL ON FUNCTION refresh_card_owner_stat(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_card_owner_stat() FROM PUBLIC;
REVOKE ALL ON FUNCTION get_card_owner_stats(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_card_owner_stats(UUID, INTEGER) TO service_role;

-- card_owner_stats は get_card_owner_stats() 経由でのみ参照する
-- サーバーサイド集計テーブル。channel_point_usage_stats（00045/00047）と
-- 同様に直接アクセスを閉じ、service_role のみ許可する。
ALTER TABLE card_owner_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage card owner stats" ON card_owner_stats;
CREATE POLICY "Service role can manage card owner stats"
ON card_owner_stats
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.card_owner_stats TO service_role;
