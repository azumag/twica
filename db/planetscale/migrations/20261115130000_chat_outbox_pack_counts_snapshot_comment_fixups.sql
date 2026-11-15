-- migration-transaction: required
-- migration-providers: planetscale

-- Issue #2047: 20261115120000_chat_outbox_pack_counts_snapshot.sql の説明コメントに
-- 含まれていた3件の不正確な記述を、catalog の COMMENT で訂正する。
-- 適用済み migration ファイルは checksum が twica_meta.schema_migrations に記録されて
-- いるためファイル自体は書き換えない（docs/db-schema-migration-reference.md）。
-- 関数・trigger の定義は正しいため実行内容は COMMENT の更新だけである。
--
-- 訂正する記述（元ファイルの -- コメント。以後はこの COMMENT を正とする）:
--   1. 元ファイル冒頭の trigger 関係の記述:
--      「どれも jsonb_set で既存payloadへ追記するだけ」は不正確。
--      snapshot_chat_outbox_delivery_settings は NEW の delivery_* 列への代入で
--      書き込み、jsonb_set は使わない。各 trigger の書き込み先が重ならないため
--      「実行順（名前順）に依存しない」という結論自体は変わらない。
--   2. 集計クエリ直上の記述: 「payload の collection_name は下の cards 行と同じ
--      snapshot の値になる」は不正確。正しくは「同じ transaction」。READ COMMITTED
--      は文ごとに snapshot を取り直すため、payload 組み立ての文と outbox INSERT の
--      間に並行 transaction が pack 名変更を commit すると、payload 側のパックキーが
--      集計結果に現れず {packUnique} は欠落＝空文字になり得る（fail-closed 側）。
--   3. 使用 index の記述: 記載されていた idx_user_cards_user_card の利用は想定に
--      すぎず、使用 index は実行計画次第。適用環境での実測は user_cards 参照に
--      idx_user_cards_user_id を使う hashed SubPlan だった。

SET LOCAL lock_timeout = '5s';

COMMENT ON FUNCTION public.snapshot_chat_outbox_pack_counts() IS
  'テンプレートが{packUnique}/{packAll}を使う場合だけ、当選カードの各パックについてcommit時点の所持種類数と有効カード総数をpayload.chatSnapshot.packCountsへ保存する（Issue #2045）。例外は外へ出さず無加工で返す。訂正（#2047）: 同じBEFORE INSERT trigger群と実行順に依存しないのは書き込み先が重ならないためで、delivery settings triggerは列代入・このtriggerはjsonb_setで書き込む。payloadのcollection_nameと集計が読むcards行は同じtransaction内だがREAD COMMITTEDでは文ごとにsnapshotを取り直すため、間に並行renameがcommitされるとパックキーが欠落し空文字になり得る。user_cards参照のindexは実行計画次第（実測はidx_user_cards_user_idのhashed SubPlan）。';
