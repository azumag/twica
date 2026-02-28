-- Migration: Fix RLS policies to restrict access to service_role only
-- RLSポリシーの修正: TO句を追加し、service_roleのみに操作を制限する
--
-- 問題:
-- 00001/00002 のポリシーに TO 句がなく、FOR ALL USING (true) が
-- anon/authenticated を含む全ロールに適用されていた。
-- NEXT_PUBLIC_SUPABASE_ANON_KEY はブラウザに露出しているため、
-- Supabase REST API を直接叩けば認証なしでテーブルを操作可能な状態だった。
--
-- 修正:
-- TO service_role を明示し、anon/authenticated からの直接アクセスを拒否する。
-- SELECT 用の公開ポリシーは条件付き (is_active = true) のため安全、維持する。

-- ========================================
-- 00001_initial_schema.sql のポリシー修正
-- ========================================

-- streamers: 管理用ポリシーを service_role に制限
DROP POLICY IF EXISTS "Service can manage streamers" ON streamers;
CREATE POLICY "Service can manage streamers" ON streamers
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- users: 管理用ポリシーを service_role に制限
DROP POLICY IF EXISTS "Service can manage users" ON users;
CREATE POLICY "Service can manage users" ON users
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- cards: 管理用ポリシーを service_role に制限
DROP POLICY IF EXISTS "Service can manage cards" ON cards;
CREATE POLICY "Service can manage cards" ON cards
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- user_cards: 管理用ポリシーを service_role に制限
DROP POLICY IF EXISTS "Service can manage user_cards" ON user_cards;
CREATE POLICY "Service can manage user_cards" ON user_cards
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- gacha_history: INSERT/SELECT ポリシーを service_role に制限
DROP POLICY IF EXISTS "Service can insert gacha history" ON gacha_history;
CREATE POLICY "Service can insert gacha history" ON gacha_history
  FOR INSERT TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service can view gacha history" ON gacha_history;
CREATE POLICY "Service can view gacha history" ON gacha_history
  FOR SELECT TO service_role
  USING (true);

-- ========================================
-- 00002_add_battle_features.sql のポリシー修正
-- battles/battle_stats テーブルが存在しない環境ではスキップ
-- ========================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'battles') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Service can manage battles" ON battles';
    EXECUTE 'CREATE POLICY "Service can manage battles" ON battles FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'battle_stats') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Service can manage battle_stats" ON battle_stats';
    EXECUTE 'CREATE POLICY "Service can manage battle_stats" ON battle_stats FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END
$$;

-- ========================================
-- 00004_add_twitch_tokens_to_users.sql のポリシー修正
-- ========================================
-- auth.uid() ベースのポリシーはカスタムCookie認証と互換性がなく
-- 常にFALSEを返すデッドコード。削除して service_role ポリシーに統合。

DROP POLICY IF EXISTS "Users can update own twitch tokens" ON users;
DROP POLICY IF EXISTS "Users can read own twitch tokens" ON users;
