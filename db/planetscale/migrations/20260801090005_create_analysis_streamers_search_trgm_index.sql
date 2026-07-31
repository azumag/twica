-- migration-transaction: forbidden
-- migration-providers: planetscale
--
-- streamers一覧とGachaの配信者候補検索はusername/display_name/twitch_user_id
-- の部分一致を受け付ける。3列を1本のGIN索引にまとめ、既存UIの検索契約を
-- 変更せずに候補抽出の全表走査を避ける。

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_streamers_analysis_search_trgm
  ON public.streamers USING gin (
    twitch_username public.gin_trgm_ops,
    twitch_display_name public.gin_trgm_ops,
    twitch_user_id public.gin_trgm_ops
  );
