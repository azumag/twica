# 現行 QA

## 通常ゲート

```bash
npm run check:supabase-shutdown
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run workers:build
npm run auxiliary-workers:build
npm run check:supabase-shutdown -- --require-open-next --require-aux-workers
```

analysis dashboard は `analysis/` で `npm ci`, `npx tsc --noEmit`, `npm run build` を実行し、
生成 bundle に旧 provider が含まれないことを CI で確認します。

## Preview 実経路ゲート

DB、OAuth、EventSub、overlay、chat に触れる変更は preview へ配備し、次を確認します。

1. Twitch の実チャネルポイント報酬を複数回引き換える。
2. 各結果が順番どおり overlay に表示される。
3. 各結果の chat メッセージが送信される。
4. EventSub direct と Queue replay の両経路を確認する。
5. overlay WebSocket を再接続し、polling gap recovery で欠落・重複がないことを確認する。
6. analysis dashboard の主要集計が PlanetScale の値と一致することを確認する。
7. アップロード経路に影響する変更では、対象ファイルのアップロード、保存先からの取得、権限境界、Workerログを確認する。

production 反映後は同じ主要経路を smoke test し、旧 provider の outbound request と
Secret access がゼロであることを観測してから旧 Secret を削除します。

## Preview昇格時の累積変更テスト

previewからmainへ昇格する際のテスト対象は、起点となった単一PRではなく、同じpreview HEADに含まれる昇格対象**全PRの累積変更**とする。

- mainとの差分およびpreview→main昇格PRの差分を固定し、含まれる全PR番号・各HEAD SHA・preview merge SHAを記録する。
- 各PRの呼び出し元、共有契約、DB/キュー/Worker/overlay経路を横断して確認し、PR同士の組み合わせによる退行も対象にする。
- いずれかの構成PRがEventSub、gacha、overlay、chat、アップロードなど実引き換え経路に影響する場合、上記「Preview 実経路ゲート」1-6の該当項目を累積変更全体に対して再実行し、履歴、チャット、overlay、Workerログを相関させる。単一PRだけのテスト成功や合成demo表示は代替にならない。
- 累積変更のいずれかに必須レビュー・必須CI・実経路ゲートの未達があれば、（緊急本番修正の例外を除き）昇格を止め、原因と対象PRをIssueまたは昇格PRへ記録する。
- 構成PRを切り離す場合は、対象PRをrevertする変更をpreviewへ反映して新しいHEADを作り、残りのPRだけを新しいリリース単位として再レビュー・再テストする。未達ゲートを飛ばして部分昇格してはならない。
- 構成PRを再投入する場合は、revertのrevertを含む新しいPRとして、累積変更全体を再レビュー・再テストする。
- Issueを作成する場合は、対象環境を `preview` または `production` のいずれかに固定し、事象名を次の閉じた集合から選ぶ: `ci-failure`、`workers-build-failure`、`deploy-failure`、`health-check-failure`、`real-path-eventsub`、`real-path-gacha`、`real-path-overlay`、`real-path-chat`、`real-path-upload`、`real-path-queue-replay`、`real-path-websocket-gap-recovery`、`real-path-analysis-dashboard`、`unknown-failure`。該当しない場合は `unknown-failure` とする。タイトルは `[preview-gate] <対象環境>: <事象名>` とし、重複判定キーはこのタイトルの対象環境と事象名だけにする。HEAD/merge SHAはキーに含めず、Issue本文の観測メタデータとして追記する。
- 起票前に `auto-generated` と `bug` の両ラベルの存在を確認し、無ければ作成する。ラベルの作成・付与に失敗した場合は起票せず、阻害理由を記録する。**Issue作成時には必ず両ラベルを付与する。**重複判定の本命は、`GET /repos/azumag/twica/issues?state=open&per_page=100&page=<n>` を`Link: rel="next"`が無くなるまで全ページ走査して得た項目のうち、`pull_request`フィールドを持たないIssueのタイトル完全一致である。完全一致Issueのラベルが欠けていれば両ラベルを修復してから使用する。REST Issues List APIが失敗した場合は起票せず、阻害状態を記録して次回の同じリリースゲート実行で再試行する。GitHub Searchを使う場合も `repo:azumag/twica is:issue is:open in:title "[preview-gate] <対象環境>: <事象名>"` に限定し、候補取得後にタイトル完全一致を確認する。Searchはラベル欠損Issueを見落とし得るため、REST結果を常に優先する。
- GitHub Searchは補助であり、重複判定の唯一のガードにしない。マーカーの正本は、同じpreview HEADのpreview→main昇格PRが存在する場合はそのPR、存在しない場合は同じHEADに含まれる起点PRのうち最小のPR番号とし、選択したPR番号をリリース記録へ記載する。マーカーは正本PRの**1つの機械可読コメントを更新**して管理し、コメント内にキーごとの状態行を置き、各キーについて常に最新状態だけを有効とする。状態は次のいずれかである: `<!-- preview-gate-key: <対象環境>: <事象名>; state=pending; lease_until=<ISO8601> -->`、`<!-- preview-gate-key: <対象環境>: <事象名>; state=created; issue=#<番号> -->`、`<!-- preview-gate-key: <対象環境>: <事象名>; state=retired; issue=#<番号> -->`、`<!-- preview-gate-key: <対象環境>: <事象名>; state=blocked; reason=<redacted>; at=<ISO8601> -->`。昇格PRが後から作られた場合は、起点PRの最新マーカー状態を昇格PRへ移送し、起点PR側には移送先PR番号を記録する。両方を同時に正本として扱わない。
- まずREST Issues List APIで完全一致Issueを確認し、見つかれば`created`マーカーを設定してそのIssueへコメントする。Issueが無く`pending`のリースが期限内なら新規起票せず、期限とキーを阻害理由として記録する。期限切れならREST APIで再確認し、なお無ければ新しい10分間の`pending`マーカーを設定してからIssueを作成する。マーカーが無い場合も同じ順序で`pending`を設定してから作成する。`created`マーカーのIssueがクローズ済み・削除済みなら、そのマーカーを`retired`へ更新し、同じキーの新しいリリース単位として`pending`から再起票する。
- `release-unit` は固定したpreview HEAD SHAを使う `preview-head:<SHA>` とし、preview merge SHA・昇格PR番号はその単位の観測メタデータとして同じIssueへ記録する。Issue本文またはコメントには、各単位を`release-unit: preview-head:<SHA>; status=<open|resolved>`の形式で一度だけ記録する。新しいSHAの同一事象でも重複起票せず、同じIssueへ新しいリリース単位の証拠を追記する。Issueは**現在列挙されている未解消のリリース単位がゼロ**になった時だけクローズし、未解消単位が一つでもある間はクローズしてはならない。クローズ済みIssueに同じキーが再発した場合は、`retired`マーカーから新しいリリース単位の`pending`へ進み、新しいIssueを作成する。クローズ時は対応するマーカーを`retired`へ更新する。
- Issue作成に成功したら直ちに`created; issue=#<番号>`マーカーを設定する。作成応答が不明、または作成後のマーカー更新に失敗した場合でも、次回の同じリリースゲート実行はREST Issues List APIの完全一致を先に行い、見つかったIssueへ追記してマーカーを修復する。完全一致Issueが無く、`pending`リースが期限切れになった場合だけ再起票を許可する。REST、ラベル、マーカー、Issue作成のいずれかが失敗した場合は正本PRのマーカーを`blocked`へ更新し、キー・失敗した操作・時刻・(redacted)済みエラー概要を記録する。次回の同じリリースゲート実行がこの`blocked`を再確認して、成功すれば`pending`または`created`へ遷移させて再試行する。マーカー更新自体に失敗した場合は起票せず、その失敗を最終報告の阻害理由として残す。10分間の`pending`リースはIssue作成操作だけを保護し、実経路テスト全体の期限ではない。Search APIの障害・インデックス遅延・プロセス停止でも、同一事象を重複起票せず、Issue起票が永続的に失われない。
- 証拠を記録する前に、種別を問わず資格情報・認証情報・署名鍵・接続文字列・署名付きURL・個人識別値をすべて `(redacted)` に置換する。代表例はアクセストークン、リフレッシュトークン、`client_secret`、Cookie、`session_id`、`EVENTSUB_REPLAY_SECRET`、PlanetScale接続文字列、Cloudflare APIトークン、Twitch EventSub署名シークレット、OAuthの`code`/`state`である。未加工のログやスクリーンショットは添付せず、redaction済みの抜粋だけを証拠として記録する。
- 通常のリリースは、レビュー判定、必須CI、preview検証、必要な実経路確認、main昇格、productionデプロイ、タグとリリース本文の確認を順に満たしてから完了とする。緊急本番修正だけは明示的な例外として、最小テストと静的検証後に復旧を優先できるが、復旧後に独立レビューと未達ゲートの充足を終えるまで成功扱いにしない。

## Transactional chat outbox

ガチャ確定とチャット通知payloadは
`execute_gacha_transaction_with_chat_outbox` が同じDB transactionでcommitします。
Twitch Chat APIにはidempotency keyがないため配送保証は **at-least-once** です。
通常の同時relayは60秒のowner-fenced leaseで抑止しますが、Twitch送信成功後かつ
DBの`sent`記録前に実行環境が停止した場合だけ、lease失効後に同じ通知が重複し得ます。
欠落を避けるため、この境界では再送を優先します。

- チャット無効時はoutbox行を作らず、DB容量とrelay負荷を増やしません。
- 429、5xx、通信障害は1分、5分、15分、60分のbackoffで最大5回試行します。
- scope/credential欠落、429以外の4xx、不正payloadは`dead`へ移し、後続を塞ぎません。
- N連は最終drawのtransactionで全`gacha_history`を順序付き再構成し、全件揃った
  完成済み`pending`だけを作ります。途中失敗で配送不能な`building`行を残しません。
- N連途中のDB一時障害は、ライブWebhookへ2xxを返す前に生通知を7日TTLのKV durable
  inboxへ保存します。Cron replayが確定済みprefixを飛ばして残りを完遂し、最終drawが
  outboxを組み立てます。KV保存にも失敗した通常時だけ503を返してTwitch再送を要求します。
- `{num}`、`{unique}`、`{all}`、`{newCards}`はガチャcommit時点の値をoutboxへ保存し、
  relay時に現在の所有数/catalogを再読込しません。backoff中に別ガチャや設定変更が
  起きても、初回に送る予定だった本文を維持します。
- `sent`は7日、`dead`は調査用に30日保持した後、Cron relayが削除します。
- DB outbox relayはmaintenance EventSubのKV一覧取得より先に実行します。KV障害中も
  チャットbacklogは1回につき最大`limit`件ずつ進みます。

保証境界は新RPCを使うアプリrevisionのdeploy時刻です。schema-first期間に旧RPCで
すでに全drawが完了した履歴は、当時チャット送信済みか判定できないためbackfillせず、
重複通知を避けます。旧revisionで一部だけ完了し、新revisionで最終drawを再開した
バッチは、最終transactionが既存履歴を再構成してoutboxを作ります。

### 障害確認

```sql
SELECT id, batch_id, status, expected_draw_count, assembled_draw_count,
       attempt_count, next_attempt_at, lease_expires_at, last_error,
       created_at, sent_at, dead_at
FROM chat_notification_outbox
WHERE status IN ('pending', 'processing', 'dead')
ORDER BY created_at;
```

`dead`を再送する前に、`last_error`、Twitch scope/token、payload、対応する
`gacha_history.event_id`を確認します。N連が部分完了してoutbox自体が無い場合は、
通知行だけを手作業で作らず、ガチャ部分完了の原因を先に調査します。再送して安全だと
確認した`dead` 1件だけを次のように戻し、管理relayを1回実行します。

```sql
UPDATE chat_notification_outbox
SET status = 'pending',
    attempt_count = 0,
    next_attempt_at = now(),
    lease_id = NULL,
    lease_expires_at = NULL,
    last_error = NULL,
    dead_at = NULL,
    updated_at = now()
WHERE id = '<confirmed-outbox-uuid>'::uuid
  AND status = 'dead';
```

```bash
EVENTSUB_REPLAY_SECRET=... npm run replay:maintenance-eventsub -- \
  --url=https://<target-preview-or-production-host> --limit=20
```

復旧後は対象行が`sent`になり、同じ`batch_id`のチャットが高々1回追加されたことを
確認します。送信成功後のack前停止を意図的に再現した試験では重複が許容結果です。

CIはPostgreSQL 17 serviceへPlanetScale baselineと全追加migrationを順次適用し、
旧/新RPC、single/N連、歯抜け復旧、NULL副作用0、権限、lease fencingを実SQLで検証します。
SQL本文の文字列検査だけをmigration構文のgateにしてはいけません。
