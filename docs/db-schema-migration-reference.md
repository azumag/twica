# DB schema migration reference

`src/lib/db/schema.ts` は既存 PostgreSQL schema に対する Drizzle の型付けであり、migration の生成元ではありません。schema 上の列や制約の由来を確認するときは、実際の migration SQL を正本として参照します。

## Migration の配置

- `supabase/migrations/`: 歴史的なディレクトリ名を維持している共通 DDL の正本です。
- `db/planetscale/migrations/`: PlanetScale にだけ適用する migration の正本です。

`node scripts/db-migrate.js --provider=planetscale ...` は両方のディレクトリを読み込みます。したがって、`schema.ts` の保守コメントで migration を参照するときは、番号だけでなく配置先も確認してください。

## 既存テーブルへの DDL と lock_timeout

既存テーブルに DDL ロックを取る migration（`ALTER TABLE` / `CREATE TRIGGER` / `CREATE INDEX` 等）は、ファイルの先頭で `SET LOCAL lock_timeout = '5s';` を宣言します。

- DDL が要求する `ACCESS EXCLUSIVE` 等の強いロックは、行ロックと違ってロックキューの先頭で待つと、後続の弱いロック（通常の SELECT / UPDATE）までまとめてブロックします。cards / trade_offers のようにガチャ・トレードの実経路から常時アクセスされるテーブルでは、長いトランザクションの後ろでこの待ちが発生すると、後続の機能全体が止まります。
- `lock_timeout` で待ちを打ち切れば migration は失敗しますが、`migration-transaction: required` のトランザクション内なので何も残りません。再実行は `planetscale-migrate.yml` の `workflow_dispatch` で行います。
- `SET LOCAL` なので効果はその migration のトランザクション内だけです（`migration-transaction: forbidden` のファイルでは使えません）。競合が無い通常時のロック取得は即時に終わるため、常に宣言してよいガードです。
- 基準値の 5 秒と書き方の前例は `db/planetscale/migrations/20261018030000_trade_auctions.sql` です（この方針として最初に設定した migration。baseline の pg_dump 由来の `SET LOCAL lock_timeout = 0` は除く）。

**適用済みの migration に遡って lock_timeout を追加してはいけません。** `scripts/db-migrate.js` はファイル内容全体の SHA-256 を `twica_meta.schema_migrations` へ記録し、適用済み version の checksum が変わっていると status / plan / apply / verify のいずれも即座にエラー終了します。main と preview は同じファイル群を共有するため、片方だけに効く変更は作れず、編集は適用済み環境の migration パイプライン全体を壊します。実際に `20261014100000_card_trade_wantable.sql`（preview 適用済み）へ lock_timeout を追記したところ、preview の `planetscale-migrate.yml` が checksum 不一致で失敗しました（run 39193633861、取り消し済み）。適用済みファイルは unit テストで checksum を凍結して以後の編集を CI で検出します（`tests/unit/chat-outbox-pending-kind-continuation-backfill-migration.test.ts` が最初の前例）。

なお `20261014100000` はこの方針の前に書かれた migration で、lock_timeout 無しのまま確定します。trade 機能の migration は 2026-10-19 時点で main（本番）には未リリースのため本番適用は将来のリリース時に起きますが、同一ファイルの checksum は全環境で一致しなければならないため、本番向けだけの追記もできません。preview は 2026-10-13 に同じ内容で適用されており、以後の migration は上の方針でガードします。

## Live Directory 設定列

`streamers.publish_live_status` と `streamers.publish_stats` は `supabase/migrations/20260811000000_add_live_directory_settings.sql` で追加されました。

その後、初回リリース前の仕様整理を `supabase/migrations/20260811120000_add_live_directory_rankings.sql` で行い、`publish_stats` の意味を「統計値そのものを公開するか」ではなく、`/live` のランキング上でチャネル名・画像・リンクなどの識別情報を表示するかどうかのオプトインとして確定しています。

このため、`schema.ts` で Live Directory 設定列の由来や意味を追う場合は、列追加元だけでなくランキング仕様を確定した後続 migration も合わせて確認してください。

Refs #1190 #1191 #921
