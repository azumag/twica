# docich Actions silence watch 運用手順

`azumag/docich` の GitHub Actions が「実行ゼロ（無音）」になる事象を、
twica 側の scheduled workflow `.github/workflows/docich-actions-silence-watch.yml`
が外部から監視し、Discord へ通知する。背景と調査結果は azumag/docich#3509。

## 検知ロジック

- 1 時間ごとの schedule と main への push で起動する。
  （元は 15 分間隔だったが、GitHub の高頻度 cron 抑制で実効数時間に1回以下
  だったため 1 時間間隔へ引き下げた。azumag/docich#3509 参照）
- `GET /repos/azumag/docich/actions/runs?per_page=1` の最新 run `created_at` と
  repo の `pushed_at` を読み、以下の複合条件でアラートする:
  - 最新 run から `SILENCE_THRESHOLD_SECONDS`（2 時間）超過、**かつ**
  - `pushed_at` が同期間内（push/マージの活動はあるのに run が無い）。
- 同じ判定を control group（azumag/twica、azumag/soviet_now）にも適用し、
  「docich のみ無音 = リポジトリ固有」「control も無音 = プラットフォーム側
  部分障害の疑い」を通知文に自動付記する。

## アラートが来たときの対応

1. 通知文の切り分けを確認する。
   - `repo-specific`: docich の Actions 設定（Settings → Actions）、
     前回の事象と同様に run の最終時刻・GitHub status・他リポジトリの
     稼働を確認し、owner の security log か GitHub Support で原因を特定する。
   - `platform-suspect`: githubstatus.com の incident を確認し、復旧を待つ。
2. 無音期間中にマージされた PR の一覧を `is:merged merged:<期間>` で集計し、
   復旧後の main CI が緑であることを確認する（未検証コードの事後検証）。

## 通知の頻度制御

- 最終送信時刻を `docich-actions-silence-watch/alert` の commit status として
  記録し、抑制窓（55 分）内の送信は省略する。run 自体は failure のまま残る。
- 正常に戻ると `docich-actions-silence-watch/recovered` status が置かれ、
  次の無音は抑制されず即時通知される。

## 生存確認（heartbeat）

workflow_dispatch で `heartbeat=true` を指定して実行すると、アラート条件を
満たさない場合に限り現在の観測値を Discord へ送る。webhook の疎通確認と
watchdog 自身が生きていることの確認に使う。

## 既知の限界

- 本 workflow 自体が GitHub Actions で動くため、GitHub Actions の
  プラットフォーム全体障害では自壊しうる（アラート自体が出ない）。
- GitHub は 60 日間アクティビティが無いリポジトリの schedule を自動無効化
  する。twica が静止化すれば本監視も止まる。
- これらが問題になる場合は Cloudflare Workers Cron 等のプラットフォーム外
  スケジューラへの置き換えを検討する。
