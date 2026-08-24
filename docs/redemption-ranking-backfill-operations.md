# 引き換えランキング backfill の運用注意

`db/planetscale/migrations/20260819120000_exclude_streamer_and_bot_from_redemption_rankings.sql`
には、既存の `channel_point_usage_stats` を `gacha_history` から再集計する一回限りの
backfill が含まれます。

## なぜ注意が必要か

この migration はファイル全体をトランザクションで実行し、冒頭で
`SET LOCAL statement_timeout = 0` を指定しています。backfill では production の
`gacha_history` を全件走査して `channel_point_usage_stats` を DELETE / UPSERT するため、
データ量や同時書き込み状況によってはトランザクションとロックの保持時間が長くなる可能性があります。

特に配信中のガチャ処理は同じ `channel_point_usage_stats` を更新するため、backfill と競合すると
通常の引き換え処理を待たせる可能性があります。

## 適用時の運用

- production への適用は、可能な限り配信・ガチャ利用が少ない時間帯に行う。
- 適用前に、長時間実行中の migration や DB ロック競合がないことを確認する。
- 適用中は migration の実行時間と DB の待機・ロック状況を監視し、通常のガチャ書き込み遅延が増えていないか確認する。
- 想定外に長時間化した場合は、場当たり的に別セッションから同じ backfill を重ねて実行しない。
- 適用後は `channel_point_usage_stats` の更新が通常どおり進むことを確認する。

## migration 自体を変更しない

この文書は既存 migration の実行時リスクを補足する運用メモです。適用済み migration の
`statement_timeout` や backfill SQL を後から編集して解決するものではありません。将来、
データ量の増加で一括 backfill が実運用上許容できなくなった場合は、別 migration / 運用スクリプトで
バッチ化や明示的な `lock_timeout` を導入する方針を別途検討します。

Refs #1036
