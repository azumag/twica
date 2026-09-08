# #720 検証記録

## 仕様と実装
- 報酬カードは同一配信者の inactive カード。通常/パック別コンプの条件から除外。
- 現時点の active 全種類所持かつ総数 > 0 の場合のみ付与。DBも現在状態を再検証。
- 設定・付与・解除・リネームは配信者行ロックで直列化。設定とカードactive化はカード行ロックで競合制御。
- `grants` UNIQUE と `user_cards` INSERT は単一トランザクション。上限対象外。
- 設定一覧から判定するため、名前付きパック未使用でも default 報酬を付与可能。
- 設定変更/解除後も過去の付与履歴は残り、同じパックには再付与しない。
- 全体/パック進捗は報酬取得前後で不変。所有枚数の統計には取得した報酬を含める。
- locked props はパック名・状態・rarityのみ。既取得は付与時のカードを表示。
- PlanetScale単一接続。Issue本文のdual-driverは廃止済みのため再導入しない。
- Server Component内でrevalidateTagはできないため、付与履歴をキャッシュせず、報酬カードの現在所有枚数を再取得して当該描画へ反映する。
- 通常カードだけの報酬未設定コレクションはgrantsクエリを実行しない。設定解除後も報酬バッジを残すため、inactive所有カードがある場合は履歴を読む。
- メンテナンス中の閲覧では付与RPCを実行しない。

## 確認済み（2026-09-08 JST）
- 全unit: 336 files / 3986 tests pass（追加のAPI/SQL回帰テストも個別pass）。
- integration: CSRF 13 tests pass。ローカル専用PG: 並行付与/active化/リネーム等5 tests pass。
- 全baseline + additive migrationsを専用PostgreSQLへ適用し、service_roleでSQL fixture pass。
- typecheck / Next build / OpenNext Worker build / 補助Worker全4build pass。
- lint: 0 errors、既存warningあり。変更したアプリファイルにはwarningなし。
- migration-order / maintenance inventory / Supabase shutdown（全bundle含む）pass。
- 自己レビューで既存pack_rarity_weightsのリネーム追従漏れを修正、実PGで再検証。
- ロック方式は https://www.postgresql.org/docs/current/explicit-locking.html の行ロック仕様を参照。

## 未確認・阻害理由
- previewブラウザーアクセス: 管理ポリシーを検証できずツールがアクセス拒否。安全制御を迂回していない。
- 375px実画面、設定→取得→reloadのpreview E2E、固定overlay/chat等は未実施。
- 実環境db:push:dry: DATABASE_URLがこの作業環境に未設定。ローカル全schemaの適用成功とは区別する。
- Claude Auto Reviewは現行workflowで停止中（#1390）。独立エージェントレビューはユーザー指定により実行していない。
- 上記の未確認を成功扱いせず、preview/main/production昇格は保留する。

## CI SQL fixture
`tests/fixtures/pack-completion-rewards-postgres.sql` は全schema適用後のCI専用DBで実行する。
fixtureはBEGIN/ROLLBACK内で、service_role権限・循環しないコンプ条件・冪等性・空パック・保護・リネームを検証する。
`tests/integration/pack-completion-rewards-pg.test.ts` は専用の破棄可能なPGへ
`PACK_REWARD_TEST_DATABASE_URL`を指定して実行する追加の同時接続テスト。
共有DB/本番を指定してはならない。

追加の並行テスト用ローカルDBは空の専用clusterで作成し、
`tests/fixtures/pack-completion-rewards-local.sql`、新規migrationの順に適用する。
fixtureのロール・簡略tableは本番/共有DBへ適用しない。CIの全schema検証には上記の別fixtureを使う。
