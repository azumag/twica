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

production 反映後は同じ主要経路を smoke test し、旧 provider の outbound request と
Secret access がゼロであることを観測してから旧 Secret を削除します。

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
