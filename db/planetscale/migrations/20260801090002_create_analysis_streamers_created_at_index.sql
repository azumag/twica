-- migration-transaction: forbidden
-- migration-providers: planetscale
--
-- 配信者一覧の既定ソートを支える索引。通常のCREATE INDEXではなく
-- CONCURRENTLYで適用し、preview/mainのmigration中も書き込みを止めない。

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_streamers_created_at_analysis
  ON public.streamers (created_at DESC);
