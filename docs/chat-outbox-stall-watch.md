# Chat outbox 滞留監視 (Issue #1837)

## 背景

Issue #1665 の設計で、`CHAT_DELIVERY_DISPATCH_ENABLED` が ON のあいだ 20 分周期 Cron
relay（`POST /api/admin/eventsub-replay`）は配送 owner（claim→送信→ack）から外れ、
due 行の起床通知 enqueue（`dispatchDueChatNotifications`）だけを行う。配送本体は
`chat-notification-wakeup` Queue → `twica-chat-delivery` Worker → 内部
`/api/internal/chat-outbox` 経路が担う。この設計は旧経路への自動フォールバックを
持たない（二重 owner 防止のため）。このため以下のどれかが起きると、DB の
`chat_notification_outbox` pending 行が滞留する以外に **利用者が気づける変化なく**
配送が静かに止まる:

1. Queue consumer（twica-chat-delivery Worker）の停止・未配備
2. `CHAT_DELIVERY_SECRET` 未設定で内部 endpoint が 500 を返し続ける
3. Queue binding 未設定で enqueue が `unavailable` を返し続ける
4. consumer から内部 endpoint への HTTP 呼び出しがタイムアウトし続ける
5. sweep（chat-delivery Worker の 1 分周期 scheduled handler）が due 行を
   予約（wake_reserved_until）に掛けられない

## 仕組み

`.github/workflows/chat-outbox-watch.yml` が **5 分周期**（GitHub Actions
schedule。混雑時は遅延しうる）で production を観測する。監視対象である
Cloudflare 側ではなく GitHub 側に置くことで、Cloudflare 全体が停止しても通知を
発火できる。観測はすべて **読み取り専用**:

- production DB: `PGOPTIONS=-c default_transaction_read_only=on` でセッション全体を
  読み取り専用にし、実効値を確認してから集計する
  （db-readonly-check-production.yml と同じ手順・同じ Environment secret）。
- Cloudflare Queues: realtime backlog metrics API
  （`GET /accounts/{account_id}/queues` で `queue_name` から `queue_id` を引き、
  `GET /accounts/{account_id}/queues/{queue_id}/metrics` で
  `backlog_count` / `oldest_message_timestamp_ms` を読む）。production の
  `CLOUDFLARE_API_TOKEN` に Queue 読み取り権限が無い場合（HTTP 403）や queue が
  見つからない場合は警告だけ出し、DB 側の検知を継続する（後述）。

### アラート条件（閾値は 3 条件とも 300 秒）

| 条件 | 観測内容 | 検知する故障 |
|---|---|---|
| `due_pending_stall` | `status='pending' AND next_attempt_at <= now()` の行の最古 `next_attempt_at` が 300 秒を超えて経過 | 上記 1〜5 のすべて（pending 行が消化されない形で現れる） |
| `processing_lease_stall` | claim 済み行 (`status='processing'`) の lease が 300 秒を超えて失効したまま | consumer が claim 直後に応答なく停止した行の放置（due 滞留には現れない盲点） |
| `queue_backlog_stall` | `chat-notification-wakeup` の最古滞留メッセージが 300 秒を超える | consumer 全滅でメッセージだけ積もる状態 |

閾値 300 秒の根拠: 健康な経路では sweep が 1 分周期で wake 予約（120 秒窓）を
行い、claim の lease は 60 秒、due 行は数秒〜2 分で消費される。300 秒はこれらの
どの余裕も超える。**`CHAT_DELIVERY_DISPATCH_ENABLED` を OFF に戻す運用（旧 20 分
周期 relay が owner に戻る）では due 行が 20 分待つのが正常になるため、本 watch
は頻繁に誤報する。flag を OFF にする際は本 workflow の無効化か閾値引き上げを
セットで行うこと。**

### アラート内訳の読み方（原因の切分け）

Discord 通知と run log には内訳が載る:

| 内訳 | 意味 | 次に見る場所 |
|---|---|---|
| `wake予約 新鮮` が多い | sweep は予約だけ続けていて消化されていない。`reserved > 0` のまま `enqueued = 0` が続く（enqueue 失敗・binding 未設定）か、enqueue は成功しているが consumer が死んでいる | 下記「queue backlog」の有無で分岐。積っていなければ producer 側（binding・flag）、積っていれば consumer 側 |
| `wake予約 期限切れ` が多い | sweep 自体がこの行を 2 分以上拾えていない。chat-delivery Worker の scheduled handler と relay sweep の両方が止まっている | Worker の deploy 状態・Observability |
| `attempt枯渇` が 0 より大きい | 試行上限（CHAT_OUTBOX_MAX_ATTEMPTS = 5）に達した pending 行。flag ON では sweep の対象外のため誰も起こさず永久滞留する。手動確認が必要 | 該当行の `last_error`（read-only workflow で確認） |
| `processing lease失効` が 0 より大きい | claim 後に放置された行。再帰 consumer が立てば回収される | consumer の実行ログ |
| `pending far-future(>30分)` / `gate far-future(>30分)` | 同一チャンネルへの大量積みなどで channel gate が 30 分以上先に進んでいる。単体ではアラートしない参考値 | 該当チャンネルの pending 行数・`reserve_chat_channel_send_slot` の呼び出し頻度 |

## 通知先と頻度制御

- 通知先: repo secret `DISCORD_WEBHOOK_URL`（main merge 通知と同じ Discord
  channel）。本文は件数・経過秒・実行時刻のみで、batch_id（視聴者に紐づきうる）・
  last_error（外部 API 応答を含む）・DB 名・queue ID は載せない。
- アラート検知時は run を **failure** にする。Actions の赤 run・failure email が
  第 2 の可視経路になり、Discord 送信の成否に依存しない。
- 滞留が継続する間の毎周期送信を防ぐため、**最後に Discord 送信に成功した時刻**を
  main の HEAD コミットへの commit status（context: `chat-outbox-watch/alert`）に
  記録し、抑制窓（55 分）以内の run では Discord 送信だけを省略する。run は
  failure のまま残る。anchor は「実際に送信した run」だけが作るため、観測不能
  エラー（psql 接続断など）が直前にあっても、その直後に始まった本物の初回
  アラートは黙らない。停滞継続中は約 55 分ごとに anchor が空いて再送する。
  - main への新しい push で SHA が変わると anchor は引き継がれず、停滞継続中でも
    1 回余分に通知しうる（新コードでの再確認として許容）。正常 run（success）を
    1 つでも挟めば次の滞留は即時通知される。

## アラートが来たら何をするか

1. **run log で内訳を確認する**（上記「アラート内訳の読み方」）。
2. **queue 観測の行を見る**: `queue=chat-notification-wakeup backlog_count=...`
   - `::warning::queue metrics unavailable (HTTP 403)` の場合は token の Queue
     読み取り権限不足。DB 側の条件で検知は継続しているが、権限を足すなら
     production Environment secret の `CLOUDFLARE_API_TOKEN` に Queues Read を
     追加するか、読み取り専用 token を別 secret にして workflow を切り替える。
   - backlog が積っている（`queue_backlog_stall`）→ consumer 側。
     `npx wrangler tail twica-chat-delivery` で deliver/dispatch-due の失敗を確認。
   - backlog が空のまま due 滞留 → producer 側。本体アプリの
     `CHAT_NOTIFICATION_QUEUE` binding・`CHAT_DELIVERY_DISPATCH_ENABLED`・
     dispatch sweep のログ（`[chat-notification-dispatch]`）を確認。
3. **DB の現状を読む**: `gh workflow run db-readonly-check-production.yml --ref main`
   の結果（件数・実行計画）と、必要なら本 workflow の再実行。
4. **復旧**: 障害箇所を直す（Worker 再配備・secret 設定・binding 修正）。滞留行は
   pending のまま残っているため、経路が回復すれば sweep と consumer が自動回収
   する。`attempt枯渇` 行だけは回収されないため、内容を確認の上、dead 化など
   個別判断を行う。
5. **flag を OFF に戻す判断をした場合**: 旧 20 分周期 relay が owner に戻るため、
   本 watch は誤報し続ける。本 workflow を無効化するか閾値を 25 分以上へ
   引き上げること（この文書を更新してから行う）。

## 手動実行（生存確認）

```bash
gh workflow run chat-outbox-watch.yml --ref main -f heartbeat=true
```

`heartbeat=true` は、アラート条件を満たして **いない** 場合に限り、現在の観測値を
載せた生存確認メッセージを Discord へ送る。webhook URL を変更した直後の疎通確認に
使う。アラート条件を満たしている場合は通常のアラート経路が優先される。
SQL・閾値・Environment を変える input は存在しない。

## 関連

- Issue #1837（本監視の要件） / Issue #1665（配送 owner の切り替え設計）
- PR #1872（観測点 2 の in-band 側実装: `dispatchDueChatNotifications` の構造化ログ・
  `reserved > 0 なのに enqueued = 0` の警告ログ。本 watch が外側で検知した滞留の
  原因を、Cloudflare Observability のこのログで切分ける）
- `tests/unit/chat-outbox-watch-workflow.test.ts`（workflow 契約テスト）
- `tests/fixtures/chat-outbox-watch-pg17.mjs`（観測 SQL とアラート判定の実 PG17 回帰）
- `docs/eventsub-subscription-health.md`（アプリ内エラー → 自動 GitHub Issue 化の
  既存パイプライン。本 watch は監視対象の外側に置くため、あえてこの経路には
  乗せていない。内部経路化する場合は「監視対象の停止が観測も止める」点を再検討
  すること）
