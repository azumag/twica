-- migration-transaction: forbidden
-- migration-providers: planetscale
--
-- usersのILIKE '%query%'をpg_trgmのGIN索引で支える。前方一致へ契約を
-- 変えると既存の部分一致検索を壊すため、検索仕様を維持したままDB側の
-- 文字列走査を減らす。username/display_nameを同じGIN索引へまとめ、OR
-- 条件の検索で使える候補を1本の索引から提供する。

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_analysis_search_trgm
  ON public.users USING gin (
    twitch_username public.gin_trgm_ops,
    twitch_display_name public.gin_trgm_ops
  );
