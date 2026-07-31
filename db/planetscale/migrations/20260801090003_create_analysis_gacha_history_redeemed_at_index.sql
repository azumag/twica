-- migration-transaction: forbidden
-- migration-providers: planetscale
--
-- Overviewの直近履歴・日次集計とGacha一覧の期間絞り込みを支える索引。
-- gacha_historyは追記が継続するため、通常のCREATE INDEXによる書き込み
-- ロックを避けてCONCURRENTLYで作成する。

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gacha_history_redeemed_at_analysis
  ON public.gacha_history (redeemed_at DESC);
