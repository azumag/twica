-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #1953: マイコレクション(/dashboard/collection)の配信者コレクションの非表示。
--
-- 視聴者が「この配信者のコレクションは一覧に出したくない」と思ったとき、一覧から
-- 外せるようにする(再表示も可能)。非表示は「一覧の見せ方」だけの設定で、
-- カードの所持・/collection/[streamerId] への直リンク・統計には一切影響しない。
-- そのためカード(user_cards)側には触らず、視聴者ごとの非表示設定を別テーブルに持つ。
--
-- 方針(expand のみ・加法的変更):
--   - 新規テーブル1つの追加だけ。既存テーブルの列・制約・トリガーは変更しない。
--   - twitch_user_id キーにする理由は announcement_reads / collection_completions と同じ。
--     セッションが持つ識別子(twitchUserId)でそのまま読み書きでき、users との JOIN を
--     読み取りパスに要求しない。users への FK は張らない(users 行が無い視聴者でも
--     整合が崩れず、users 削除時の連鎖削除も不要。非表示設定は失われても困らない)。
--   - streamer_id だけ streamers(id) への FK + ON DELETE CASCADE を張る。配信者が
--     削除されたら、その配信者に対する非表示設定は意味を失うので一緒に消す。
--   - 非表示/再表示はアプリ側で INSERT ... ON CONFLICT DO NOTHING / DELETE にする
--     ため、(twitch_user_id, streamer_id) の複合 PK が冪等性の根拠になる。PK の
--     先頭が twitch_user_id なので「あるユーザーの非表示一覧」の取得は PK の
--     index scan で済み、追加の index は不要。
--
-- migration 未適用の窓(アプリと migration の適用は非同期。docs/db-driver-migration.md):
--   新アプリの一覧取得は 42P01(テーブルが無い)を「非表示なし」として扱い、一覧は
--   従来どおり全件表示する。非表示 API は 500 を返すだけで、他の機能には波及しない。
--
-- 旧アプリ(ロールバック後)との互換:
--   旧アプリはこのテーブルを参照しないので、非表示にした配信者も一覧に全件表示される
--   だけ(データは壊れない)。

-- 本 migration は新規テーブルを作るが、FK 追加時に参照先の既存テーブル streamers へ
-- SHARE ROW EXCLUSIVE ロックを取る。streamers はガチャ・チャット・ダッシュボードの
-- 実経路から常時読み書きされるため、長いトランザクションの後ろでこのロック待ちが
-- 発生すると、待ちの後ろに後続の通常クエリが全部並んで止まる(ロックキューの先頭で
-- 待つ DDL が後続の弱いロックもブロックするため。docs/db-schema-migration-reference.md)。
-- 5秒で諦めて migration ごと失敗させ(トランザクションなので何も残らない)、再実行に
-- 任せる方が安全。SET LOCAL なのでこのトランザクション内だけに効く。
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.user_collection_hidden_streamers (
  twitch_user_id text NOT NULL,
  streamer_id uuid NOT NULL REFERENCES public.streamers(id) ON DELETE CASCADE,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (twitch_user_id, streamer_id)
);

COMMENT ON TABLE public.user_collection_hidden_streamers IS
  'マイコレクション一覧で視聴者が非表示にした配信者(#1953)。一覧の見せ方だけの設定で、カード所持・直リンク・統計には影響しない。';
COMMENT ON COLUMN public.user_collection_hidden_streamers.twitch_user_id IS
  '非表示にした視聴者の Twitch ユーザーID(セッションの twitchUserId)。users への FK は張らない。';
COMMENT ON COLUMN public.user_collection_hidden_streamers.hidden_at IS
  '非表示にした日時。INSERT 時の DEFAULT のみで、重複操作(ON CONFLICT DO NOTHING)では更新しない。';

-- 権限: RLS は使わない。現行の PlanetScale 直結経路には PostgREST が存在せず、
-- テーブルへ到達できるのはアプリの DB ロールだけなので、新設しても公開面は増えない
-- (20261023000000_storage_reservation_and_reconcile.sql / 20261018030000_trade_auctions.sql
-- と同じ判断)。grants.sql の ALTER DEFAULT PRIVILEGES は「migration を適用した
-- ロール」に依存して静かに効かなくなり得るため、ここで明示的に REVOKE / GRANT する。
REVOKE ALL ON TABLE public.user_collection_hidden_streamers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_collection_hidden_streamers TO service_role;
