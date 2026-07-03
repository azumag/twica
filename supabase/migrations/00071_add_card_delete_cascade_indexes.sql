-- Issue #614: DELETE /api/cards/[id] が本番で Postgres の
-- statement timeout (57014 "canceling statement due to statement timeout")
-- を起こした障害の恒久対策。
--
-- 実際に発生したログパターン: DELETE /api/cards/[id] リクエストの
-- 約11秒後に statement timeout が発生。src/app/api/cards/[id]/route.ts の
-- DELETE ハンドラ(514-517行目)は `DELETE FROM cards WHERE id = $1` を
-- 1回発行するだけで、事前チェックや分割削除は行っていない。実際の削除コストは
-- cards.id を参照する5本の外部キーに対する Postgres の
-- ON DELETE CASCADE / ON DELETE SET NULL に委ねられている。
--
-- FK列にインデックスが無いと、カスケード処理は各子テーブルに対して
-- `WHERE fk_col = $1`(SET NULLの場合は `UPDATE ... SET fk_col = NULL
-- WHERE fk_col = $1`)を子テーブル全件のシーケンシャルスキャンで実行する。
-- cards.id を参照する5列のうち、user_cards.card_id のみ 00001 で索引済み
-- (idx_user_cards_card_id, 00001_initial_schema.sql:70)。残り4列は
-- 無索引だったため、本migrationで以下を追加する:
--
-- 1. gacha_history.card_id (00001_initial_schema.sql:61, ON DELETE CASCADE)
--    gacha_history はプラットフォーム最大のイベントログテーブル
--    (00051_add_card_owner_stats.sql:1-6 で言及の通り、旧実装は
--    PostgREST の1万件フェッチ上限に達した実績がある)。索引なしの
--    カスケードDELETEは同テーブルの全件シーケンシャルスキャンになり、
--    本障害の主因と推定される。
--
-- 2. battles.opponent_card_id (00002_add_battle_features.sql:18,
--    ON DELETE CASCADE)
--    対戦相手カードとして参照する battles 行の削除も同様に全件スキャンになる。
--
-- 3. card_owner_stats.card_id (00051_add_card_owner_stats.sql:21,
--    ON DELETE CASCADE)
--    既存の複合索引 idx_card_owner_stats_card_rank
--    (streamer_id, card_id, owned_count DESC, last_obtained_at DESC ;
--    00051_add_card_owner_stats.sql:34-40) はリーディング列が streamer_id
--    のため、card_id 単独条件のカスケード検索には使えない。加えて、
--    cards 削除に伴う user_cards の CASCADE DELETE は行ごとに
--    trg_sync_card_owner_stat トリガー(00051_add_card_owner_stats.sql:149-153)
--    を発火し、削除された user_cards 1行につき
--    sync_card_owner_stat()/refresh_card_owner_stat() が SELECT 2回 + 書き込み
--    1回を実行する(00051_add_card_owner_stats.sql:73-124)。これは
--    所有者数の多い人気カードほどコストが乗算される別経路だが、
--    トリガー自体のロジックは正しく Issue #614 のスコープ外のため変更しない。
--    ここでは card_owner_stats 自身の CASCADE DELETE を高速化する。
--
-- 4. card_stone_transactions.card_id (00059_add_card_stones_exchange.sql:18,
--    ON DELETE SET NULL)
--    索引なしでは `UPDATE card_stone_transactions SET card_id = NULL
--    WHERE card_id = $1` が全件スキャンになる。
--
-- CONCURRENTLY は使わない: 00032_add_get_gacha_users_for_streamer.sql の
-- 先例と同じ理由で、CREATE INDEX CONCURRENTLY はトランザクションブロック内
-- では実行できず、supabase db push によるマイグレーション適用は
-- トランザクション内で行われるため、通常の CREATE INDEX IF NOT EXISTS を
-- 使う。将来、本番の巨大テーブルに無停止で適用し直したい場合は、
-- 手動で CONCURRENTLY 版を個別実行することを検討する。
--
-- 命名規則は既存の idx_user_cards_card_id (00001) に倣い
-- idx_<table>_<column> とする。
--
-- battles テーブルのみ存在チェックで囲む: 00024_fix_rls_policies_security.sql
-- が明記する通り、本番環境には battles/battle_stats テーブルが存在しない
-- (battle 機能はどのナビゲーションからもリンクされていない未使用機能で、
-- テーブル自体がマイグレーション経路外で欠落している)。無条件の
-- CREATE INDEX ON battles(...) は本番で
-- "relation battles does not exist" (42P01) で失敗し、本ファイルは
-- 単一トランザクションのため他3つのインデックスも道連れでロールバックし、
-- 後続マイグレーションを全てブロックしていた。00024 と同じ
-- pg_class 存在チェックで回避する。

CREATE INDEX IF NOT EXISTS idx_gacha_history_card_id
  ON gacha_history(card_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'battles') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_battles_opponent_card_id ON battles(opponent_card_id)';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_card_owner_stats_card_id
  ON card_owner_stats(card_id);

CREATE INDEX IF NOT EXISTS idx_card_stone_transactions_card_id
  ON card_stone_transactions(card_id);
