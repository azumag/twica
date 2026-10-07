# Rate Limit Backend Policy (#728)

本ドキュメントは rate limit バケットごとの backend 分離方針を記録する。
backend の自動置換は行わない。有効化・配備は別途承認が必要。

## 分類 (main, #1759 マージ済み)

| バケット | 用途・しきい値 | backend | 障害時 |
|---|---|---|---|
| `authLogin` (5回/分/IP) | ログイン総当り防止 | Durable Object (strict)。`STRICT_RATE_LIMITER` binding がある場合のみ有効 | fail-closed (503 + `Retry-After: 30`)。信頼できる Cloudflare IP が無い `ip:unknown` も fail-closed |
| `activateCode` (5回/時/ユーザー) | 支援コード総当り防止 | Durable Object (strict)。同上 | fail-closed (同上) |
| その他全バケット (`global`, `tradeRead`/`tradeWrite`, `gacha*`, `cards*`, `eventsub*` 等) | 濫用抑止・DDoS 緩和 | KV (`RATE_LIMIT_KV` 自動初期化) + memory。`src/lib/rate-limit.ts` の soft 経路 | fail-open (既存契約を維持) |

分類の機械的固定: `tests/unit/rate-limit-bucket-policy.test.ts`。
strict バケットの追加・削除はセキュリティレビューを要する。
strict を外すことは総当り防御の穴に直結し、soft を strict に変えることは
binding 障害時の 503 停止範囲を広げる。どちらも本ドキュメント更新つきの別変更で行う。

## なぜ KV を厳密用途に使わないか

現行 `KVRateLimitStorage` は同一 `ratelimit:<name>:<identifier>` key への
`get()` → `count++` → `put()` (read-modify-write) 方式。Cloudflare Workers KV の
公式契約 (https://developers.cloudflare.com/kv/api/write-key-value-pairs/,
https://developers.cloudflare.com/kv/api/read-key-value-pairs/) では:

- 同一 key への書き込みは最大 1 write/秒。1秒以内の複数 write は `429` になり得る
- KV は eventual consistency。同じ key への同時 write は上書き競合し得る
- write は同一 location では即時可視だが、別 location へは最大60秒遅延し得る

現行コードは storage error を catch して許可する fail-open 契約のため、
KV の same-key write 制限による `429` がそのまま rate-limit の fail-open へ
つながり得る。write が成功しても別 location 間の RMW は原子的共有カウンタに
ならない。したがって「`RATE_LIMIT_KV` へ配線されている」ことと「分散環境で
厳密な rate limit として成立する」ことは別問題であり、総当り防止の2バケットは
Durable Object の直列化カウンタへ分離する。DO 有効後に DO が失敗した場合は
KV へフォールバックしない (静かに非原子的 fail-open へ戻ることを防ぐ)。

## Preview 実測の状態

- 2026-10-07 read-only 確認: `twica-preview` Worker は存在し、最新デプロイは
  2026-10-04T15:21:41Z。`wrangler.toml` に `STRICT_RATE_LIMITER` binding は無く
  (preview_id 付きで bind 済みなのは `RATE_LIMIT_KV` のみ)、strict 経路は
  preview でも休眠中 (soft fallback) のままである。
- 既往の read-only 観測 (2026-09-21/24): 通常トラフィック窓で KV get/put 例外に
  よる fail-open warning は確認されなかった。ただし別 isolate 間のカウンタ共有、
  same-key 1 write/sec 競合、eventual consistency、KV 起因レイテンシ/コストの
  証明にはならない。
- 未検証のまま残す: 分散 isolate 越し共有・KV レイテンシ/コスト・fail-open 妥当性、
  DO 有効化後の cross-isolate 直列化・レイテンシ・binding 障害時の挙動。
  preview への負荷生成は本 PR の範囲外とし、再現試験は別途承認の上で行う。

## 有効化ゲート (DO binding 配備は含まない)

1. `STRICT_RATE_LIMITER` の binding/migration 配備は別途承認 (本 PR は wrangler 設定・
   Cloudflare リソース・secret・デプロイ設定を変更しない)。
2. 配備後は preview で cross-isolate 挙動・レイテンシ/コスト・binding 障害時挙動を
   検証してから有効化する。
3. production 有効化・デプロイはさらに別の判断とする。

## 関連

- #728 (本 Issue。本文の残作業チェックのうち方針判断を本ドキュメントで確定し、
  preview 実測はゲート付き残件として維持する)
- PR #1262 (KV 自動初期化の回帰テスト)、PR #1632 (production observability 補強)、
  PR #1759 (strict DO 経路の実装。Refs #728 でマージ済み)
