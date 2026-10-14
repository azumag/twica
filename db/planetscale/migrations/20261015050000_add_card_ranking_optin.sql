-- migration-transaction: required
-- migration-providers: planetscale

-- #934 同志カードコーナー（docich）: 名前つき視聴者ランキングの公開オプトイン。
--
-- 20261015040000 の get_card_ranking は集計だけを担い、公開の可否はこの列と
-- wrapper get_published_card_ranking が決める。既定は FALSE（明示的同意が原則。
-- publish_live_status / publish_stats と同じ方針）で、ユーザー向けの設定 UI は
-- 用意しない。有効化は operator が明示的に行う。
--
-- opt-in していない streamer では、公開 route が呼ぶ wrapper が SQLSTATE P0002 で
-- fail-closed になる。route はこれを 404 へ写像し、未知の streamer と同じ応答に
-- することで「どのチャンネルが opt-in 済みか」を探れないようにする。
ALTER TABLE streamers
  ADD COLUMN IF NOT EXISTS publish_card_ranking BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN streamers.publish_card_ranking IS
  '同志カードの名前つき視聴者ランキング公開オプトイン (#934)。既定OFF・ユーザー向けUI無し';

-- 同志カードコーナー（docich）が表示するチャンネルだけを初期有効化する。
-- CI / preview のように該当行が無い環境では 0 行更新の no-op になり migration は
-- 失敗しない。本番では DoCiAI (Twitch login: dociai) の 1 行だけが対象。
-- ユーザー向けの設定画面は追加しないため、他チャンネルの有効化もこの形で行う。
UPDATE streamers
   SET publish_card_ranking = TRUE
 WHERE lower(twitch_username) = 'dociai';

-- 公開 route が呼ぶ唯一の入口。opt-in の判定を DB 側に閉じ込め、route 側の
-- フィルタに依存しない（既存の「フロント側フィルタは禁止」方針と同じ）。
CREATE OR REPLACE FUNCTION public.get_published_card_ranking(
  p_streamer_id uuid,
  p_period text DEFAULT 'all',
  p_limit integer DEFAULT 10
) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_streamer_id IS NULL THEN
    RAISE EXCEPTION 'card_ranking: streamer id is required' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM streamers s
     WHERE s.id = p_streamer_id
       AND s.publish_card_ranking
  ) THEN
    -- 未 opt-in と未知の streamer を区別しない（応答を同じにして探索を防ぐ）。
    RAISE EXCEPTION 'card_ranking: not published' USING ERRCODE = 'P0002';
  END IF;
  RETURN public.get_card_ranking(p_streamer_id, p_period, p_limit);
END;
$$;

-- 公開 route 経由でのみ読めるようにする（20261015040000 の get_card_ranking と同じ扱い）。
REVOKE ALL ON FUNCTION public.get_published_card_ranking(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_published_card_ranking(uuid, text, integer) TO service_role;

-- ゲートの迂回を塞ぐ: 集計本体は wrapper からのみ到達させる。SECURITY DEFINER の
-- wrapper は所有者権限で実行されるため、アプリ用ロールからの EXECUTE を落としても
-- wrapper 経由の呼び出しは維持される。
--
-- 注記: baseline の db/planetscale/grants.sql は
-- `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role` を含むため、
-- 災害復旧で grants.sql を再適用するとこの REVOKE は戻る。公開面の実効的なゲートは
-- route が呼ぶ wrapper（opt-in 判定）側であり、この REVOKE は二重防御である。
REVOKE EXECUTE ON FUNCTION public.get_card_ranking(uuid, text, integer) FROM service_role;
