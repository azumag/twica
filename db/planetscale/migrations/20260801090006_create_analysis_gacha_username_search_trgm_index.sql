-- migration-transaction: forbidden
-- migration-providers: planetscale
--
-- Gacha画面で明示的に「全期間」を選んだ場合も、ユーザー名の部分一致検索を
-- 受け付ける。7日が初期値ではあるが、全期間検索を選択した管理者の入力だけで
-- gacha_history全体をcount/dataの2回走査しないよう、pg_trgmのGIN索引を用意する。
-- 追記が継続する大きな履歴表への索引作成で書き込みを長時間ブロックしないため、
-- このDDLは通常transactionから分離したCONCURRENTLYで適用する。

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gacha_history_username_analysis_search_trgm
  ON public.gacha_history USING gin (
    user_twitch_username public.gin_trgm_ops
  );
