-- Issue #625: 本番 cards テーブルのスキーマドリフト修復 (repair migration)
--
-- 背景:
-- 本番 Supabase では、以下2本の migration がマイグレーション履歴テーブル上は
-- 「適用済み」と記録されているにもかかわらず、実際の cards テーブルには
-- それぞれが追加したはずの列・制約・indexが存在しないことが実測で確認された
-- (#625)。原因は不明(過去のドリフト事故と見られるが、再現条件は特定できていない)。
--
--   - 00002_add_battle_features.sql: hp/atk/def/spd/skill_type/skill_name/skill_power
--   - 00037_add_card_number.sql: card_number 列 + cards_card_number_positive
--     CHECK 制約 + cards_streamer_card_number_unique 部分unique index
--
-- このドリフトにより、DB_DRIVER=pg-read の本番では cards の無指定 SELECT が
-- 毎回 42703 (undefined_column) で失敗し、src/lib/db/cards-safe-columns.ts の
-- CARDS_SAFE_COLUMNS フォールバック (8列除外での再試行) で救済されている
-- (アプリの動作自体は正しいが、リクエスト毎に2クエリ + WARNING ログが発生する)。
--
-- 冪等設計の理由:
-- preview 環境には上記8列が (ドリフトなく) 既に存在するため、本 migration を
-- preview へ適用しても完全な no-op で成功する必要がある。一方、本番はこれらの
-- 列がまだ存在しない状態なので、未適用環境に対しては 00002/00037 が本来
-- 作るはずだった最終状態と完全に一致する列・制約・indexを新規作成する。
-- そのため全ての DDL を IF NOT EXISTS (または「存在確認してから作成」の
-- DO ブロック) で書き、どちらの初期状態から流しても同じ最終状態に収束させる。
--
-- 列定義は 00002_add_battle_features.sql / 00037_add_card_number.sql の内容、
-- および src/lib/db/schema.ts の cards テーブル定義と完全に一致させている
-- (デフォルト値・NULL許容・CHECK制約・index定義とも突き合わせ済み)。

-- ---------------------------------------------------------------------------
-- 00002_add_battle_features.sql 由来: バトルステータス7列
-- ADD COLUMN IF NOT EXISTS は列単位で判定されるため、8列全体を1本の
-- ALTER TABLE にまとめても一部の列だけ既存という状況でも安全に動作する。
-- ---------------------------------------------------------------------------
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS hp INTEGER DEFAULT 100,
  ADD COLUMN IF NOT EXISTS atk INTEGER DEFAULT 30,
  ADD COLUMN IF NOT EXISTS def INTEGER DEFAULT 15,
  ADD COLUMN IF NOT EXISTS spd INTEGER DEFAULT 5,
  ADD COLUMN IF NOT EXISTS skill_type TEXT DEFAULT 'attack',
  ADD COLUMN IF NOT EXISTS skill_name TEXT DEFAULT '通常攻撃',
  ADD COLUMN IF NOT EXISTS skill_power INTEGER DEFAULT 10;

-- skill_type の CHECK 制約は ADD COLUMN と同時に書けない (列が既存の場合は
-- スキップされてしまう) ため分離する。制約名は元 migration 実行時に
-- Postgres が自動採番する既定名 (cards_skill_type_check) に合わせ、
-- 存在しない場合のみ追加する。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cards_skill_type_check'
      AND conrelid = 'public.cards'::regclass
  ) THEN
    ALTER TABLE cards
      ADD CONSTRAINT cards_skill_type_check
      CHECK (skill_type IN ('attack', 'defense', 'heal', 'special'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 00037_add_card_number.sql 由来: card_number 列 + CHECK 制約 + 部分unique index
-- 元 migration のスキーマ修飾 (public.cards) をそのまま踏襲する。
-- ---------------------------------------------------------------------------
ALTER TABLE public.cards
  ADD COLUMN IF NOT EXISTS card_number integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cards_card_number_positive'
      AND conrelid = 'public.cards'::regclass
  ) THEN
    ALTER TABLE public.cards
      ADD CONSTRAINT cards_card_number_positive
      CHECK (card_number is null or card_number > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS cards_streamer_card_number_unique
  ON public.cards (streamer_id, card_number)
  WHERE card_number IS NOT NULL;

-- 注意: 本 migration での修復後も、列の「物理順序」は preview と本番で一致しない
-- (preview は is_active の直後、本番は末尾に追加される。PostgreSQL は位置指定の
-- ADD COLUMN ができないため不可避)。列定義・制約・index は完全に一致するが、
-- 列リスト省略の INSERT や位置ベースの参照を書くと環境間で挙動が割れるため、
-- cards テーブルへのアクセスは必ず列名ベースで行うこと (現行コードは全て列名アクセス)。
