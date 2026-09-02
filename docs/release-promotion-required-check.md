# Preview→main 昇格時の required status check

preview から main への昇格PRでは、`.github/workflows/notify-discord-main-merge.yml` の `validate-promotion-summary` を required status check として扱います。

## 運用契約

- repository rules / branch protection で `validate-promotion-summary` を required status check として登録・維持する。
- 昇格PRの `validate-promotion-summary` が未実行、pending、failure、cancelled、skipped など `success` 以外の場合は main へマージしない。
- workflow はリリース要約の検証ロジックと check run を提供する。required 化そのものは repository rules / branch protection 側の責務であり、workflow ファイルだけではマージ禁止を保証しない。
- check 名を変更する場合は、workflow と repository rules / branch protection の required check 設定を同時に更新し、保護が外れる時間を作らない。

この文書は運用契約の記録のみを目的とし、workflow・repository rules / branch protection・runtime の設定自体は変更しません。
