# Preview→main 昇格時の required status check

preview から main への昇格PRでは、`.github/workflows/notify-discord-main-merge.yml` の `validate-promotion-summary` を required status check として扱います。

## 運用契約

- repository rules / branch protection で `validate-promotion-summary` を required status check として登録・維持する。
- 昇格PRの `validate-promotion-summary` が未実行、pending、failure、cancelled、skipped の場合は main へマージしない。
- workflow はリリース要約の検証ロジックと check run を提供する。required 化そのものは repository rules / branch protection 側の責務であり、workflow ファイルだけではマージ禁止を保証しない。
- required status check の context は workflow ファイル名ではなく **job 名**（`validate-promotion-summary`）で決まる。job 名を変更する場合は repository rules / branch protection の required check 設定を同時に更新し、保護が外れる時間を作らない。
- GitHub は skip された job を成功として扱う（`.github/workflows/ci.yml` の注記参照）。required 設定だけでは skip を検知できないため、「昇格PRで `validate-promotion-summary` が skipped のままならマージしない」は運用側で守る。
- workflow は `preview` へマージする機能 PR の Discord 通知も兼ねるため `preview` 向け PR でも起動するが、`validate-promotion-summary` job は base が `main` かつ head が同一リポジトリの `preview` のときだけ実行する。preview 向け PR では job が skip され、この check を required として扱わない。`pull_request_target` の workflow ファイルは既定ブランチ（`main`）から解決されるため、preview 側の変更は main 昇格後に有効になる。
- 実際に required として登録されているかは下記「現状」を確認し、未有効の間はこの契約が成立していないものとして扱う。

## 現状（2026-10-14 実測）

この節は契約が実際に有効かどうかの実測記録です。**現時点で `validate-promotion-summary` は required status check として実効化されていません。**

- `gh api repos/azumag/twica/rulesets` → `main`（id `12459399`）が1件のみで `enforcement: disabled`。`rules` は `deletion` / `non_fast_forward` / `pull_request` / `copilot_code_review` のみで、`required_status_checks` ルールは無い。
- `gh api repos/azumag/twica/branches/main/protection` → 404（旧 branch protection は未設定）。

このため main へのマージ可否は、いまも workflow の検証結果ではなく通常のレビュー判断に依存しています。workflow 側の `validate-promotion-summary` は check run として記録され、レビュー材料としては機能しますが、`success` 以外を GitHub がブロックする状態にはなっていません。

## 有効化手順（実施するときの確認方法）

1. GitHub の **Settings → Rules → `main`** で enforcement を有効化し、required status checks に job 名 `validate-promotion-summary` を追加する。
2. この ruleset は現在 disabled のため、有効化すると `deletion` / `non_fast_forward` / `pull_request` / `copilot_code_review` も同時に有効になる。main の保護方針として意図どおりかを先に確認する。
3. 有効化後は次で読み戻し、`enforcement` と required status checks の context が `validate-promotion-summary` になっていることを確認する。

```bash
gh api repos/azumag/twica/rulesets/12459399 \
  --jq '{enforcement, rules: [.rules[] | {type, parameters}]}'
```

4. 実際の昇格PRで `validate-promotion-summary` が `skipped` ではなく実行され、`success` になっていることを GitHub 上で確認する。

この文書は運用契約と現状の記録のみを目的とし、workflow・repository rules / branch protection・runtime の設定自体は変更しません。
