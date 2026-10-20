# Rate Limit Backend Policy (#728)

本ドキュメントは rate limit バケットごとの backend 分離方針を記録する。
backend の自動置換は行わない。有効化・配備は別途承認が必要。

## 分類 (main / preview の実装契約)

| バケット | 用途・しきい値 | backend | 障害時 |
|---|---|---|---|
| `authLogin` (5回/分/IP) | ログイン総当り防止 | Durable Object (strict)。`STRICT_RATE_LIMITER` binding がある場合のみ有効 | fail-closed (503 + `Retry-After: 30`)。信頼できる Cloudflare IP が無い `ip:unknown` も fail-closed |
| `activateCode` (5回/時/ユーザー) | 支援コード総当り防止 | Durable Object (strict)。同上 | fail-closed (同上) |
| その他全バケット (`global`, `tradeRead`/`tradeWrite`, `gacha*`, `cards*`, `eventsub*` 等) | 濫用抑止・DDoS 緩和 | KV (`RATE_LIMIT_KV` 自動初期化) + memory。`src/lib/rate-limit.ts` の soft 経路 | fail-open (既存契約を維持) |

分類の機械的固定: `tests/unit/rate-limit-bucket-policy.test.ts`。
preview には main の #1759 相当の strict 実装と #1889 の専用 Worker 定義を
最小 port した。ただし app 側の `STRICT_RATE_LIMITER` binding は追加していない。
binding が無い間は `activateCode` / `authLogin` も従来の soft fallback で動くため、
コードの取り込みだけを実環境の strict 有効化・実測完了とは扱わない。
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

- 以下は strict port 前の既往実測で、すべて **soft (KV/memory) 経路**の観測であり、
  strict (DO) 経路の検証ではない。main/preview には双方に固有コミットがあるため、
  今回は全同期せず strict 部分だけを移植し、preview 独自の KV 計測・秘匿化を保持する。
- 2026-10-07 read-only 確認: `twica-preview` Worker は存在し、最新デプロイは
  2026-10-04T15:21:41Z。`wrangler.toml` に `STRICT_RATE_LIMITER` binding は無く
  (preview_id 付きで bind 済みなのは `RATE_LIMIT_KV` のみ)、strict 経路は
  preview でも休眠中 (soft fallback) のままである。
- 既往の read-only 観測 (2026-09-21/24): 通常トラフィック窓で KV get/put 例外に
  よる fail-open warning は確認されなかった。ただし別 isolate 間のカウンタ共有、
  same-key 1 write/sec 競合、eventual consistency、KV 起因レイテンシ/コストの
  証明にはならない。
- 2026-10-20 クライアント側実測 (秘密情報なし・状態変更なしの軽量計測、総リクエスト
  約250。手順と生データは #728 コメント参照):
  - **KV が実経路で実際に選択・使用されていることの機能的証明**: SJC で充填した
    カウンタを、別コロ SEA の新規接続が同一 reset epoch で 429 として観測
    (memory は isolate ローカルのためコロを跨げない。memory 説は排除)。
  - 逐次・単一接続 (同一コロ) では境界は正確に作動 (30/分で 429 開始。
    一部テストで1件の更新ロスを観測)。
  - 一方、**同一コロへの並列バースト 40 req/4.5s では 429 ゼロ**、直後の逐次
    15 req もすべて許可 — RMW 競合と same-key 1 write/sec 制限により
    非原子的カウンタが崩壊することを実測で確認 (どちらが効いたかの原因分解は
    in-Worker ログ未取得のため未確認。どちらも厳密用途には致命的)。
  - 別接続 (コロ分散) の逐次 34 req/52s も 429 ゼロ (コロ間の書き込み上書きと
    伝播遅延)。
  - 429 経路の p50 0.38s / 200 経路 (DB 込み) p50 0.68s。in-Worker の KV op
    単体時間の分離は Worker ログ (`slow storage op`) 未取得のため未確認。
  - コスト概算: 許可1リクエスト ≈ KV read 2 + write 2 (global + エンドポイント
    固有キー)。100k API req/日 ≈ write 4.5〜6M/月 ≈ $22.5〜30/月 (list price、
    ダッシュボード実数の確認は残す)。
- 未検証のまま残す: in-Worker ログ側の裏取り (`storage selected` / `slow storage op` /
  fail-open warning の頻度)、ダッシュボード側の KV 実 op 数・請求、
  DO 有効化後の cross-isolate 直列化・レイテンシ・binding 障害時の挙動。

## Durable Object Worker の配備 (#1888)

strict バケット用の DO は、アプリ本体とは別の Worker `twica-rate-limit`
(`workers/rate-limit/wrangler.toml`) として定義する。アプリ本体の entrypoint は
OpenNext の生成物 `.open-next/worker.js` で任意の class を export できないため、
class を同一スクリプトに置けない。アプリ側は Durable Object namespace を
`script_name` 付き binding で参照する。

- class: `StrictRateLimitDurableObject`
- migration: `tag = "v1"` / `new_sqlite_classes` (SQLite-backed DO)
- Worker 名: production `twica-rate-limit` / preview `twica-rate-limit-preview`

配備順序を逆にするとアプリ側 deploy が存在しない Worker を指して失敗するため、
必ず次の順で行う。

1. 対象と費用を含む実配備承認後、`npm run rate-limit:deploy:preview` で preview の
   DO Worker を配備する (新規 Cloudflare リソースの作成を伴う)。production 用の
   `npm run rate-limit:deploy` は別承認であり、preview の次に自動実行しない。
2. 配備を確認できたら、アプリ側 `wrangler.toml` に次の binding を追加する。
   この変更は別 PR とし、DO Worker の配備前に merge しない。main の
   `[env.preview]` は main からの preview upload 用で、稼働中の `twica-preview`
   は preview ブランチから配備されるため、preview 側の binding は preview
   ブランチにも別途追加する。

   ```toml
   # 本番 (top-level)
   [[durable_objects.bindings]]
   name = "STRICT_RATE_LIMITER"
   class_name = "StrictRateLimitDurableObject"
   script_name = "twica-rate-limit"

   # [env.preview]
   [[env.preview.durable_objects.bindings]]
   name = "STRICT_RATE_LIMITER"
   class_name = "StrictRateLimitDurableObject"
   script_name = "twica-rate-limit-preview"
   ```

3. binding 追加後、preview の app binding と class/script の対応および対象 bucket の
   限定契約受入で strict 経路を確認する。並列バーストで 429、DO 障害時・
   `ip:unknown` 時に 503 になることを実測し、単独の soft KV ログから判定しない。
4. preview の実測が揃ってから production の有効化を別途判断する。

`npm run rate-limit:build:production` / `rate-limit:build:preview` は wrangler の
dry-run bundle で、Cloudflare へは何も作成しない (CI の `auxiliary-workers:build`
に含まれる)。deploy 用 script は存在するが、workflow から自動実行しない。

### preview の最小 port と検証の線引き

preview は #1759 / #1889 相当の helper・strict 分岐・2 route の503応答・Worker定義・
契約テストだけを取り込む。root `wrangler.toml` と deploy workflow は変更せず、
KV/R2/Hyperdrive/Queue・UI・DB・preview 固有の soft KV 観測を保持する。

既存の固定 Wrangler 4.134.0 と main でレビュー済みの TOML をそのまま移植するため、
今回は cf/Vite への設定移行を混ぜない。認証ファイルや `.env` / `.dev.vars` を持たない
隔離 checkout と空の HOME/XDG 設定で typecheck・mock/contract tests・dry-run を行う。
ローカル dry-run 成功は Worker/DO namespace の作成、app binding の接続、
live 並列バースト429、障害時503、レイテンシや課金の実測を証明しない。

main の strict 成功経路は現在ログを追加していない。middleware の `global` などは
strict 有効化後も soft KV のままなので、`storage: kv` ログが残ることだけを
strict 休眠の証拠にしない。実環境では対象 app の DO binding と class/script の対応、
対象 bucket の限定契約受入を組み合わせて確認し、今回その live 操作は行わない。

## 有効化ゲート (DO binding 配備は含まない)

1. `STRICT_RATE_LIMITER` の実配備と app binding 接続は別工程。本最小 port は
   専用 Worker 定義のみを追加し、Cloudflare リソース・secret・実環境設定を変更しない。
2. 配備後は preview で cross-isolate 挙動・レイテンシ/コスト・binding 障害時挙動を
   検証してから有効化する。
3. production 有効化・デプロイはさらに別の判断とする。

## 関連

- #728 (本 Issue。本文の残作業チェックのうち方針判断を本ドキュメントで確定し、
  preview 実測のクライアント側結果は 2026-10-20 に記録済み)
- PR #1262 (KV 自動初期化の回帰テスト)、PR #1632 (production observability 補強)、
  PR #1759 (strict DO 経路の実装。Refs #728 で main へマージ済み)
