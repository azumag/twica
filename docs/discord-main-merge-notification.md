# Discord マージ通知の運用

`main` または `preview` へマージされた PR は `.github/workflows/notify-discord-main-merge.yml` から Discord へ通知されます。

`pull_request_target` は既定ブランチ（このリポジトリでは `main`）の workflow ファイルと context で実行されます。そのため **preview マージの通知は、この workflow が `main` に載ってから有効になります**。preview へ反映しただけでは有効化されず、通常の `preview → main` 昇格を経て有効になります。

ファイル名は `main` だけを対象にしていた当時のままですが、これは CI の paths-filter とテストの参照を無駄に動かさないための据え置きです。required status check の context は job 名 `validate-promotion-summary` であり、ファイル名の変更自体で保護が外れるわけではありません（job 名を変更する場合は repository rules / branch protection の required check 設定を同時に更新してください）。

## 必須 Repository Secret

GitHub Actions の Repository Secret として `DISCORD_WEBHOOK_URL` を設定してください。

1. GitHub リポジトリの **Settings → Secrets and variables → Actions** を開く。
2. **New repository secret** を選ぶ。
3. Name に `DISCORD_WEBHOOK_URL`、Secret に通知先 Discord チャンネルの Webhook URL を設定する。

Webhook URL は認証情報として扱い、リポジトリ、Issue、PR、CI ログ、チャットへ値を貼り付けないでください。Workflow は Secret が未設定の場合、通知前の検証ステップで失敗します。

## 通知の流れ

- `main` 向け PR がマージされたときに、production の更新として 🚀 の文言で通知します。
- `preview` 向け PR（機能 PR）がマージされたときも、同じ workflow から 🧪 の文言で通知します（有効化タイミングは上記）。preview は未リリースの配備なので、`→ preview` と表示して main のリリース通知と区別します。
- `preview → main` の昇格 PR では、PR 本文の最初の `## このリリースで変わること` セクションを通知本文として利用します。
- `preview` へのマージと `main` への直接マージには昇格要約の契約がありません。対象セクションが無ければ、サニタイズした PR タイトルを通知本文に使います（preview の PR 本文は対象セクションがある場合だけ通知に載ります）。
- fork からの PR では PR 本文を通知本文として採用せず、サニタイズした PR タイトルへフォールバックします。
- 昇格要約の欠落を warning と job failure として扱うのは、base が `main` かつ head が同一リポジトリの `preview` である昇格 PR だけです。base ref は信頼できる `pull_request_target` の base context から取得するため、PR head からは左右できません。
- 通知の宛先環境は base ref で決まります。production（🚀 / `→ main`）の文言は base が `main` と一致したときだけ使い、それ以外は preview の文言へ倒します。これにより、`BASE_REF` の欠落や将来の分岐追加があっても、未リリースの配備を「リリース済み」として告知しません。
- fork 判定は、信頼された base context の `GITHUB_REPOSITORY` と PR head 由来の `HEAD_REPOSITORY` を比較して行います。`HEAD_REPOSITORY` は非信頼入力として扱い、信頼側の基準値には使用しません。
- `pull_request_target` を使うため、Secret を読む処理は信頼された base 側の workflow だけで実行します。PR head の checkout や実行をこの workflow に追加しないでください。

## 運用確認

Secret の値そのものは表示せず、Repository Secret に `DISCORD_WEBHOOK_URL` が存在することだけを確認します。

- `main` マージ後に Actions の通知 job が成功し、Discord に production の通知が 1 件だけ届くことを確認する。
- この workflow が `main` に載った後の `preview` マージで、通知 job が成功し、Discord に preview の通知が 1 件だけ届くことを確認する（有効化前に preview へ反映して終わりにしない）。

Refs #1027 #1091
