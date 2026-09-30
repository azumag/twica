# Cloudflare cf-first 運用と移行 parity

対象: https://github.com/azumag/twica/issues/1727
確認日: 2026-09-30 UTC。この文書はリポジトリ設定の棚卸しであり、稼働中の設定を確認した証跡ではない。

## 方針と基準

新規Cloudflare操作はcf-firstとする。既存構成の切替は以下のparity gateを満たしてから行う。OpenNext / Workers Buildsの切替、Vite化、resource作成、secret更新、runtime互換日の更新を一度に混ぜない。

棚卸し基準は preview `867b13cddc54414f94c93c1d1a296a8d93234ba2`。当該時点の4つのTOML、package、Node指定、build/deployシェル、deploy workflow、Workers Builds文書はmainと同一。以後はリンク先の現行設定を優先し、変更時に本台帳も更新する。

## Worker・resource・binding 台帳

| 面 | production | preview | 維持すべき点 |
|---|---|---|---|
| 本体 | `twica` | `twica-preview` | `.open-next/worker.js` / `.open-next/assets` (`ASSETS`)、nodejs_compat、CPU 1000ms、cache enabled、observability enabled |
| RATE_LIMIT_KV | `2dadcd9aa89b466d9c860a8930d458fa` | `6604c73cdb474d6a8a50b8afd4076d5f` | rate-limit、park、demo、token、directoryのprefix分離。環境間で共有しない |
| R2_IMAGES | `twica-prod` | `twica-dev` | production TOMLのpreview_bucket_nameと、配備preview環境のbucket_nameは異なる概念 |
| R2_SOUNDS | `twica-sound-prod` | `twica-sound-dev` | 同上 |
| HYPERDRIVE_PLANETSCALE | `1dc2ec4d087e41a6931e8e18944c1fd2` | `5caf2d40d4f04fc49bc47053ab47ec22` | cache無効、origin接続上限10/5は外部設定の契約。値・接続先は変更しない |
| OVERLAY_REALTIME_SERVICE | `twica-overlay-realtime` | `twica-overlay-realtime-preview` | 同一zone global fetchへの置換不可 |
| 公開Twitch client ID | production用 | preview用 | ビルド値・callback・報酬の環境分離を維持 |
| Overlay Worker | `twica-overlay-realtime` | `twica-overlay-realtime-preview` | `OVERLAY_ROOMS → OverlayRoom`、`OVERLAY_PRESENCE → OverlayPresence`。両方SQLite DO、v1/v2履歴。observability有効、rate-limit varsも両環境で同じ |
| Error Reporter | `twica-error-reporter` | 配備なし | productionのみCI配備。5分cronと20分cron、GitHub通知、park監視・drain・health |
| Reporter KV/DB | 本体production KV/Hyperdriveと共用 | Hyperdrive `1e3f6c4569bf4202a41c42711c878b86` のみ | previewにKV/varsを継承しない縮退設定。root preview DBとはIDが異なる。勝手に統合しない |
| Chat Delivery | `twica-chat-delivery`（設定案のみ） | `twica-chat-delivery-preview`（設定案のみ） | CI配備なし。Queue作成やconsumer有効化は #1665 の別工程 |
| Chat Queue | `chat-notification-wakeup` | `chat-notification-wakeup-preview` | producer `CHAT_NOTIFICATION_QUEUE`、consumer batch=1/concurrency=5/retries=5、1分cron。現物の存在は未確認 |
| CHAT_APP | `twica` | `twica-preview` | service bindingとAPP_BASE_URLを同じ環境に向ける |

根拠: [root](https://github.com/azumag/twica/blob/preview/wrangler.toml)、[overlay](https://github.com/azumag/twica/blob/preview/workers/overlay-realtime/wrangler.toml)、[reporter](https://github.com/azumag/twica/blob/preview/workers/error-reporter/wrangler.toml)、[chat](https://github.com/azumag/twica/blob/preview/workers/chat-delivery/wrangler.toml)

## deploy・build・local dev の責任境界

1. 本体は Workers Builds: main→twica、preview→twica-preview。GitHub Actions の legacy app deploy は `CLOUDFLARE_WORKERS_BUILDS_ENABLED=true` でskipする
2. GitHub Actions は overlay両環境とreporter productionを配備する。chat-deliveryは含まない。DB migrationは独立workflowであり、deploy cancellationやWorker rollbackと結合しない
3. Cloudflare Dashboardの非production branch build OFF / build cache ON、watch pathsが一次のコスト制御。シェルの `WORKERS_CI_BRANCH` は二次防御
4. Workers CIでは不正branchのbuild/deploy/uploadをskip。CI外ではproductionの誤branch deployを拒否、previewの誤branch deployはversion uploadへ落とす。これらを `cf deploy` 直呼びへ置換しない
5. local標準は `npm run dev:next` = Next webpack / localhost:3000。Worker実行は `workers:build` の後に `workers:dev`。未buildの古い `.open-next` を正常確認として扱わない
6. Nodeは `.node-version` とdeploy workflowで20、OpenNext 1.20.2 / Wrangler 4.86.0固定。cf実装検証のNode >=22.18、Wrangler bundler >=4.136前提とは別途互換性確認が必要
7. OpenNext設定の `queue: "direct"` はadapterの設定で、chat notification Queueの配備状態を意味しない

根拠: [運用文書](https://github.com/azumag/twica/blob/preview/docs/cloudflare-workers-builds.md)、[package scripts](https://github.com/azumag/twica/blob/preview/package.json)、[deploy guard](https://github.com/azumag/twica/blob/preview/scripts/cloudflare-workers-build-deploy.sh)、[workflow](https://github.com/azumag/twica/blob/preview/.github/workflows/deploy-cloudflare.yml)

## secret・観測境界

- 本体のruntime secretとNEXT_PUBLIC_*のビルド公開値を分ける。DB接続文字列をWorkers Buildsへ複製しない。`src/lib/env-validation.ts` を必須値の基準として読み、利用箇所から任意secretも別途確認する
- Overlay: publish secret、mode、streamer allowlistを維持し、値を取得・保存しない
- Reporter: GitHub token、prod/preview replay secret、prod/preview health secret。アプリ側の対応する既存値との一致が契約。再生成や別用途流用をしない
- Chat: `CHAT_DELIVERY_SECRET` は対応する本体と同じ値の契約。設定案の移行がsecret作成の承認を意味しない
- root/overlayのobservabilityと、reporterのcron・GitHub通知を保持。tailのCLI置換とログの意味変更を混ぜない

## cf標準と明示fallback

| 操作 | 方針 | 解除条件・注意 |
|---|---|---|
| resource探索・read | cf-first。`cf cli search` でコマンド探索後、help/schemaで確認 | scope/account/IDを先に確定。API系は原則remote、ページングも確認 |
| 設定移行調査 | `cf migrate <対象TOML> --dry-run` | 事前に必要バージョンを隔離環境へ固定。dry-runは変更予定名とrequired項目を出すが生成内容のdiffは出さない |
| KV/R2/Hyperdrive/Queue/services | cf configへの対応候補あり、repo parityは未検証 | ID/name、環境差、dev接続を照合し、未指定resourceの自動作成を許さない |
| live tail | Wrangler fallback | cf betaに同等のlive tailなし。対象Worker名を明示 |
| 単一secret put | Wrangler fallback | cf betaでは未対応。secrets-file付きdeploy/version作成はsecret更新だけと同義でない |
| 本体build/deploy/upload/local Worker dev | OpenNext + 既存Wrangler経路を一時維持 | artifact形式、branch guard、公開値、secret保持、upload-only、preview QAのparity成立まで |
| Overlay DO移行 | 既存設定維持、変換を検証 | cf migrateはDO履歴を自動変換しない。live classとSQLite storage/Worker identityの確認が必要 |
| 新規独立Worker | cf config + Viteを優先 | 既存本体のframework置換や未配備chatの有効化を同時に行わない |

cfはbeta。既存TOMLに対する未移行の `cf init/dev/build/deploy` は設定を無視して自動設定するため禁止する。dry-run deployも未設定時にはファイル変更・installが起こり得る。`cf build` はpackage scriptsを実行しないため、既存guard・typecheck・artifact scannerは明示的に連結する。buildとprebuilt deployは同じmodeに揃える。

公式資料: [projects](https://developers.cloudflare.com/cf/projects/)、[migration](https://developers.cloudflare.com/cf/wrangler/migrate/)、[mapping / unsupported commands](https://developers.cloudflare.com/cf/wrangler/reference/)、[CI](https://developers.cloudflare.com/cf/ci/)、[requirements](https://developers.cloudflare.com/cf/get-started/)

## 後続検証の受入条件

- 4構成それぞれのproduction/preview出力の名前、binding、triggers、limits、cache、observabilityを基準台帳と比較。required TODOを理由なしに削除しない
- KV preview_id / R2 preview_bucket_name は新configに同名fieldがないため、local-only挙動と遠隔previewアクセスを別の判断として記録
- unknown modeがproductionへフォールバックしない安全なmode選択を提案・テストする。既存のdefault productionは移行差分として明示する
- DOは既存OverlayRoom/OverlayPresenceのSQLite identityを維持。互換日やmigration履歴の整理を付随変更で行わない
- reporter previewは縮退のまま、chatは未配備のまま。schema表現の完成と配備承認を混同しない
- `tests/unit/cloudflare-build-cost-guard.test.ts` と `tests/unit/dev-next-script-contract.test.ts` を維持し、mode/branch/target、非配備Worker、secret build漏出をcontract test化する
- artifact検査は現在の `.open-next` / auxiliary dist出力を前提とする。cf Build Outputへ移行するなら `scripts/check-supabase-shutdown.js` の検査面も同時に更新してからdeploy pathを変える
- 認証なしbuild/dry-run、typecheck、対象unit/integration、artifact scan後に、別承認でpreview実経路QAを行う。ガチャ/overlay/chatやuploadに影響する変更は `docs/QA.md` のゲートを満たす

## 今回の検証状態

実施済み: GitHub issue/最新PR確認、main/preview比較、設定・package・workflow・guard・関連テストの静的読解、Cloudflare公式仕様照合。
この文書は cfインストール、cf migrate実行、依存更新、build/test、Cloudflare live inventory、preview QA の完了証跡ではない。生成差分やruntime parityが合格したという主張はしない。
