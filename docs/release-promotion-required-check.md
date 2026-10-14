# Preview→main 昇格時の required status check

preview から main への昇格PRでは、`.github/workflows/notify-discord-main-merge.yml` の `validate-promotion-summary` を required status check として扱います。

## 運用契約

- repository rules / branch protection で `validate-promotion-summary` を required status check として登録・維持する。
- 昇格PRの `validate-promotion-summary` が未実行、pending、failure、cancelled、skipped など `success` 以外の場合は main へマージしない。
- workflow はリリース要約の検証ロジックと check run を提供する。required 化そのものは repository rules / branch protection 側の責務であり、workflow ファイルだけではマージ禁止を保証しない。
- check 名を変更する場合は、workflow と repository rules / branch protection の required check 設定を同時に更新し、保護が外れる時間を作らない。
- workflow は `preview` へマージする機能 PR の Discord 通知も兼ねるため `preview` 向け PR でも起動するが、`validate-promotion-summary` job は base が `main` かつ head が同一リポジトリの `preview` のときだけ実行する。preview 向け PR では job が skip され、この check を required として扱わない。`pull_request_target` の workflow ファイルは既定ブランチ（`main`）から解決されるため、preview 側の変更は main 昇格後に有効になる。

この文書は運用契約の記録のみを目的とし、workflow・repository rules / branch protection・runtime の設定自体は変更しません。
