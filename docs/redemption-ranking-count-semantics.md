# Redemption ranking count semantics

`channel_point_usage_stats.redemption_count` と live directory の引き換えランキングで使う
`redemption_count` は、現在は **チャネルポイント引き換えイベント数ではなく、ランキング対象として
集計されたガチャ排出カード行数**を表す。

## N連ガチャ

N連ガチャでは `executeGachaDraws` が各カードを `gacha_history` の別行として確定する。
`reward_cost` はポイントの二重計上を避けるため先頭行にだけ入り、`reward_id` は全行へ引き継がれる。
そのためランキング集計は `(reward_cost > 0 OR reward_id IS NOT NULL)` を対象とし、N連は N 件として
`redemption_count` に加算する。`SUM(reward_cost)` は NULL を無視するので、ポイント合計はこの変更で
N倍にはならない。

この意味に合わせ、UIや運用資料で `redemption_count` を説明するときは「引き換え回数」だけでなく、
必要に応じて「排出カード枚数（N連はN件）」など、N連の数え方が分かる注記を添える。

## 過去データの境界

`reward_id` は `00070_add_gacha_history_reward_id.sql` で 2026-07-04 に導入された。既存行は
`reward_id = NULL` のままなので、それ以前の履歴は `reward_cost > 0` の行だけをランキング対象として
復元する。このため **2026-07-04 より前のN連2枚目以降は履歴から復元できず、古い期間を含む集計では
現在の「排出カード枚数」意味と完全には揃わない**。

この既知の境界を隠すための推定バックフィルは行わない。現在の集計述語を累積テーブル・期間別RPCで
共通化し、同じ履歴に対して同じ結果を返すことを優先する。

## ランキング対象外

配信者本人、登録済みの配信者BOT、共有system BOTはランキング対象から除外される。レイドガチャと
手動QAドローも `reward_cost` / `reward_id` の条件を満たさないため、従来どおり対象外となる。

実装上の正本は
`db/planetscale/migrations/20260819120000_exclude_streamer_and_bot_from_redemption_rankings.sql`
の集計述語・コメントを参照する。

Refs #1036
