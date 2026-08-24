# Discord main マージ通知の運用

`main` へマージされた PR は `.github/workflows/notify-discord-main-merge.yml` から Discord へ通知されます。

## 必須 Repository Secret

GitHub Actions の Repository Secret として `DISCORD_WEBHOOK_URL` を設定してください。

1. GitHub リポジトリの **Settings → Secrets and variables → Actions** を開く。
2. **New repository secret** を選ぶ。
3. Name に `DISCORD_WEBHOOK_URL`、Secret に通知先 Discord チャンネルの Webhook URL を設定する。

Webhook URL は認証情報として扱い、リポジトリ、Issue、PR、CI ログ、チャットへ値を貼り付けないでください。Workflow は Secret が未設定の場合、通知前の検証ステップで失敗します。

## 通知の流れ

- `main` 向け PR がマージされたときに通知します。
- `preview → main` の昇格 PR では、PR 本文の最初の `## このリリースで変わること` セクションを通知本文として利用します。
- fork からの PR では PR 本文を通知本文として採用せず、サニタイズした PR タイトルへフォールバックします。
- `pull_request_target` を使うため、Secret を読む処理は信頼された base 側の workflow だけで実行します。PR head の checkout や実行をこの workflow に追加しないでください。

### 昇格要約の正本

`preview → main` の通知では、昇格 PR 本文の `## このリリースで変わること` を運用上の正本として扱います。Workflow はその要約を実差分やコミット一覧と自動照合しないため、通知内容の正確性は昇格 PR を更新する側が担保してください。実差分との機械的な整合確認が必要になった場合は、通知生成とは別の検証として追加します。

## 運用確認

Secret の値そのものは表示せず、Repository Secret に `DISCORD_WEBHOOK_URL` が存在することだけを確認します。次回の実際の `main` マージ後に Actions の通知 job が成功し、Discord に通知が 1 件だけ届くことを確認してください。

Refs #1027 #1091 #1113
