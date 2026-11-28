# Issue #2114 実装記録

対象: azumag/twica#2114「chat-delivery Worker に [observability] を有効化してログを残す」

関連: Refs #2070

この作業は worktree 内のファイル変更だけを行った。preview/production へのデプロイ、Cloudflare API の呼び出し、push、PR 作成、Issue/Slack 投稿は行っていない。

## 実施内容

### 1. `workers/chat-delivery/wrangler.toml`

- root に `[observability] enabled = true` を追加した。
- `[env.preview]` に `[env.preview.observability] enabled = true` を追加した。
- 配置と値は、動作実例のある `workers/overlay-realtime/wrangler.toml` および `workers/rate-limit/wrangler.toml` に合わせた。Traces や sampling 率の調整はこの Issue の対象外なので追加していない。
- Cloudflare の Workers Logs 仕様では `observability.enabled` は `logs.enabled` の shorthand で、`head_sampling_rate` 未指定時の既定は 1（全件）である。Traces は `observability.traces.enabled` を別途有効化する仕様なので、今回の `enabled = true` だけでは有効にならない。全件ログはコストへ影響しうるが、この Worker は 1 分 cron と queue consumer だけの低流量で、実経路ゲートの相関を優先する判断とした。
- 設定の意味と、console 出力へ秘密情報を渡さない必要があることを TOML コメントへ明記した。

### 2. `tests/unit/chat-delivery-deploy-prep-contract.test.ts`

- root と preview の両方で Workers Logs が有効であることを確認する contract test を追加した。
- このテストは、#2114 で修正した observability 設定が後続変更で脱落することを防ぐためのものである。

### 3. ログの秘密情報確認

`workers/chat-delivery/src/index.ts` に存在する全 7 件の `console.*` 出力を確認した。redact 修正は不要と判断した。

確認したログ内容:

- 内部 endpoint の HTTP status と `action`
- 内部 endpoint 呼び出し例外の `error.message` と `action`
- follow-up enqueue 失敗時の `batchId` と `error.message`
- malformed message を drop した事実
- `dispatch-due` 失敗の事実
- `dispatch-due` の status、reserved/enqueued 件数、skippedDisabled
- reserved があるのに enqueue 0 件だった場合の件数

秘密情報の扱い:

- `CHAT_DELIVERY_SECRET` は `x-chat-delivery-secret` ヘッダーへだけ設定され、ログへは渡されていない。
- リクエストヘッダー、Authorization/Bearer/Cookie、トークン、カード本文、視聴者名をログへ出す箇所はなかった。
- `batchId` は配送相関用 ID であり、設計上 token や送り先 URL を含まない。ログに残るのは follow-up enqueue 失敗時だけである。
- `error.message` にリクエストヘッダー値を埋め込むコードはない。URL へ secret を載せない設計なので、runtime エラー文が URL を含んでも `CHAT_DELIVERY_SECRET` は露出しない。

したがって、今回の observability 有効化に先立つ redact 修正は行わなかった。

## 検証結果

実施済み:

- tracked ファイルの差分について `git diff --check` が成功し、空白・patch 形式のエラーがないことを確認した。
- `workers/overlay-realtime/wrangler.toml` と `workers/rate-limit/wrangler.toml` の実例と照合し、root/preview とも `[observability] enabled = true` / `[env.preview.observability] enabled = true` の形になることを確認した。
- TOML 構造を静的に確認し、root の `[observability]` は queue 定義より前、preview の `[env.preview.observability]` は `[env.preview]` 配下にあることを確認した。既存の queue producer/consumer、Service Binding、cron、vars の記述は変更していない。
- 変更した 3 ファイルに対し、代表的な token/password/secret 代入パターンの静的 scan を行い、実値らしき秘密情報がないことを確認した。
- 変更した 3 ファイルに trailing whitespace がないことを静的に確認した。

未実施:

- この worktree には `node_modules/typescript/package.json`、`node_modules/vitest/package.json`、`node_modules/wrangler/package.json` が存在しない。project-local の typecheck、vitest、Wrangler dry-run は依存導入なしには実行できない。今回は read-only に近い実装範囲なので `npm ci` による依存導入を行わなかった。
- `npm run chat-delivery:typecheck` の実行は、この環境の実行確認で拒否されたため実施できなかった。
- Python `tomllib` による TOML parse も同様に実行拒否されたため実施できなかった。
- 上記と同じ実行経路を使う `npm run chat-delivery:build:production`、`npm run chat-delivery:build:preview`、vitest は追加で試行していない。したがって、dry-run や test が成功したとは扱わない。

ゲート側で実行可能な場合の検証コマンドは次のとおり。依存未導入の環境では、先に `npm ci` を実行する。

```bash
npm run chat-delivery:typecheck
npm run chat-delivery:build:production
npm run chat-delivery:build:preview
npx vitest run tests/unit/chat-delivery-deploy-prep-contract.test.ts tests/unit/chat-delivery-worker.test.ts
```

## preview でのログ確認手順（この作業では未実施）

以下はゲート担当または owner が preview 反映後に行う手順である。この作業では preview へのデプロイも cf o11y へのアクセスも行っていない。

### 前提

- 今回の `workers/chat-delivery/wrangler.toml` を含むバージョンが `twica-chat-delivery-preview` へ反映済みであること。
- `cf` CLI が認証済みであること。認証情報やトークンをファイル・Issue・コメントへ書かないこと。
- 確認対象 Worker 名は `twica-chat-delivery-preview` とする。
- cron は 1 分周期なので、反映後は少なくとも 2 分待ってから確認すると確認しやすい。

### 1. cf o11y query で cron/queue consumer のイベントを確認する

直近 15 分のイベントを取得する例:

```bash
now=$(($(date +%s)*1000))
cf o11y telemetry query --query-id adhoc-chat-delivery-preview --view events --limit 200 \
  --timeframe-from $((now-900000)) --timeframe-to $((now+60000)) \
  --parameters-filters '[{"key":"$metadata.service","operation":"eq","type":"string","value":"twica-chat-delivery-preview"}]' \
  --parameters-order-by-value timestamp --parameters-order-by-order asc
```

確認観点:

- cron 周期に対応する invocation イベント（`$metadata.type=cf-worker-event`）が取得できること。
- アプリログ（`$metadata.type=cf-worker`）が取得できること。
- cron では `[chat-delivery] dispatch-due sweep result` の `console.info` が 1 分周期で出ること。
- 実チャネルポイント引き換えを行った場合は、その時刻前後に queue consumer の invocation イベントが出ること。成功した consumer は現在の実装上 `console.*` を出さないため、「queue consumer の invocation はあるがアプリログが無い」だけでは失敗とみなさない。warning/error の有無と retry 挙動をあわせて見ること。

`$metadata.service` で 0 件になるが deployment 上の script 名は正しい場合は、既存の計測メモにある `$workers.scriptName` を使って同じ値 `twica-chat-delivery-preview` を照合する。

`[chat-delivery]` のアプリログだけへ絞る例:

```bash
now=$(($(date +%s)*1000))
cf o11y telemetry query --query-id adhoc-chat-delivery-preview-app-logs --view events --limit 200 \
  --timeframe-from $((now-900000)) --timeframe-to $((now+60000)) \
  --parameters-filters '[{"key":"$metadata.service","operation":"eq","type":"string","value":"twica-chat-delivery-preview"},{"key":"$metadata.message","operation":"includes","type":"string","value":"[chat-delivery]"}]' \
  --parameters-order-by-value timestamp --parameters-order-by-order asc
```

`includes` が効かない場合は、message filter を外して生イベントを取得し、ローカルで `[chat-delivery]` を含む行だけを抜粋する。生ログをそのまま Issue や PR へ貼らないこと。

### 2. live tail で cron/queue consumer を確認する

現在の cf CLI RC 系では、live tail は `cf observability tail` を使う。beta 期間中にあった `cf o11y telemetry live-tail` は RC 系で削除され、このコマンドへ置き換わっている。

```bash
cf observability tail --worker twica-chat-delivery-preview
```

なお、リポジトリ内の既存メモが例示する beta.28 系ではコマンド表面が RC 系と異なり、`cf o11y telemetry live-tail` は端末へそのままログを流す RC 系 `cf observability tail` と同じコマンドではない。利用する cf の help で stream 可否を確認し、直接 tail できない場合は、`docs/cloudflare-cf-migration.md` が明示している live tail の Wrangler fallback を使う。

```bash
npx wrangler tail twica-chat-delivery-preview
```

cron の 1 分周期をまたいで、少なくとも 2 分間 tail する。実チャネルポイント引き換えを行う場合は、引き換え前に tail を開始し、引き換え後の queue consumer invocation を同じ出力で確認する。

`[chat-delivery]` のアプリログだけへ絞る場合の例:

```bash
cf observability tail --worker twica-chat-delivery-preview \
  --filters '{"filterCombination":"and","filters":[{"key":"$metadata.message","type":"string","operation":"includes","value":"[chat-delivery]"}]}'
```

確認観点:

- cron では `[chat-delivery] dispatch-due sweep result` が観測できること。
- queue consumer 成功時はアプリログが無くても invocation イベントが観測できること。
- `[chat-delivery] internal endpoint rejected request`、`internal endpoint call threw`、`follow-up enqueue failed`、`dispatch-due produced zero enqueued despite reserved rows` などの warning が残る場合は、時刻・status/action/件数だけを redaction 済みで記録すること。

### 3. ログの秘匿確認

クエリや tail の出力を記録へ転記する前に、少なくとも次の文字列を含まないことを確認する。

- `x-chat-delivery-secret`
- `CHAT_DELIVERY_SECRET`
- `Authorization`
- `Bearer`
- `Cookie`
- `token`
- `secret`
- `password`

今回のコード監査ではこれらをログへ出す箇所はなかったが、observability の invocation イベントにはプラットフォーム側のメタデータも含まれるため、生出力の転記は避け、必要なフィールドだけを抜粋する。`batchId` は秘密情報ではないが、転記量を減らすため証拠に不要なら省略してよい。

## 残存する確認事項

- preview 反映後に cf o11y query / live tail で cron・queue consumer のイベントが実際に取得できること。
- 実チャネルポイント引き換えを伴う preview 実経路テストで、queue consumer invocation、overlay、chat、履歴、関連ログの相関を確認すること。
- 上記はデプロイと Cloudflare 側の観測を伴うため、今回の read-only 実装範囲では実施していない。ゲート担当と owner の判断で実施する。
