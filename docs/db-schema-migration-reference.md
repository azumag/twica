# DB schema migration reference

`src/lib/db/schema.ts` は既存 PostgreSQL schema に対する Drizzle の型付けであり、migration の生成元ではありません。schema 上の列や制約の由来を確認するときは、実際の migration SQL を正本として参照します。

## Migration の配置

- `supabase/migrations/`: 歴史的なディレクトリ名を維持している共通 DDL の正本です。
- `db/planetscale/migrations/`: PlanetScale にだけ適用する migration の正本です。

`node scripts/db-migrate.js --provider=planetscale ...` は両方のディレクトリを読み込みます。したがって、`schema.ts` の保守コメントで migration を参照するときは、番号だけでなく配置先も確認してください。

## Live Directory 設定列

`streamers.publish_live_status` と `streamers.publish_stats` は `supabase/migrations/20260811000000_add_live_directory_settings.sql` で追加されました。

その後、初回リリース前の仕様整理を `supabase/migrations/20260811120000_add_live_directory_rankings.sql` で行い、`publish_stats` の意味を「統計値そのものを公開するか」ではなく、`/live` のランキング上でチャネル名・画像・リンクなどの識別情報を表示するかどうかのオプトインとして確定しています。

このため、`schema.ts` で Live Directory 設定列の由来や意味を追う場合は、列追加元だけでなくランキング仕様を確定した後続 migration も合わせて確認してください。

Refs #1190 #1191 #921
