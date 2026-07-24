# PlanetScale PostgreSQL schema baseline と migration

TwiCa の永続データは PlanetScale PostgreSQL が唯一の正本です。schema の正本は
`db/planetscale/` と、`scripts/db-migrate.js --provider=planetscale` が読み込む migration です。
この文書は日常運用の手順を定義します。

## 管理対象

| パス | 用途 |
| --- | --- |
| `db/planetscale/bootstrap.sql` | 新規・検証用 DB の基盤オブジェクト |
| `db/planetscale/public-schema.sql` | public schema baseline |
| `db/planetscale/grants.sql` | baseline に必要な権限 |
| `db/planetscale/migrations/` | PlanetScale 専用 migration |
| `scripts/db-migrate.js` | history・lock・checksum を管理する実行器 |

本番・preview の runtime 接続は Cloudflare Hyperdrive、migration は GitHub Environment の
`PLANETSCALE_DATABASE_URL` を使う direct connection です。両者を取り違えたり、接続文字列を
ソース・ログ・Issue に書き出したりしてはいけません。

## 日常の migration

新しい schema 変更は、現在の PlanetScale schema と application code の両方に対して必要な
差分だけを migration として追加します。適用前後の確認は provider を必ず明示します。

```bash
node scripts/db-migrate.js status --provider=planetscale
node scripts/db-migrate.js plan --provider=planetscale
node scripts/db-migrate.js apply --provider=planetscale
node scripts/db-migrate.js verify --provider=planetscale
```

`DATABASE_URL` は環境変数からのみ取得します。CLI 引数、シェル履歴、コミット、Issue に
接続文字列を渡しません。実行器は `twica_meta.schema_migrations`、advisory lock、checksum を
使って順序・並行実行・ファイル改変を検出します。

production と preview は `.github/workflows/planetscale-migrate.yml` が対応する branch への push で
apply と verify を実行します。通常の変更は workflow に任せ、手動 apply は障害対応または
明示的な運用手順がある場合だけにします。

## 変更の安全性

Cloudflare Workers Builds と migration workflow は独立して完了するため、DB 変更は
expand/contract を原則にします。

1. まず後方互換な列・index・関数を追加する。
2. 新旧 schema の両方で動くアプリをデプロイし、migration の適用を確認する。
3. 読み書きを新しい schema へ移し、production / preview を監視する。
4. 列削除、rename、型変更などの contract は自動 migration に混ぜず、互換性確認後に
   人が順序を管理して実施する。

`migration-transaction: forbidden` を必要とする DDL は、トランザクション外実行の失敗時に
半端な状態を残し得ます。対象 SQL を最小化し、復旧手順と監視を PR に記録してから適用します。

## baseline を使う場面

`bootstrap.sql`、`public-schema.sql`、`grants.sql` は新規の検証 DB を構築するための baseline です。
既存 production / preview DB に対して、baseline を再実行して履歴や schema を修復してはいけません。
その場合は不足・不整合を migration として追加し、`plan` と `verify` で確認します。

`--bootstrap` は、DB に SQL がすでに正しく反映されていることを独立に証明できる一回限りの
履歴登録用途です。通常運用や新しい migration の適用には使いません。誤用すると SQL を実行せず
適用済みと記録するため、schema と history が乖離します。

## 廃止済み移行記録

古い baseline 作成記録には、別サービスの migration tree、CLI、SQL Editor を使う手順が
含まれていました。それらは Issue #803 完了前の歴史的調査記録であり、現行環境で実行しては
いけません。新規 migration は `db/planetscale/` と本書の provider 明示コマンドだけを使います。
