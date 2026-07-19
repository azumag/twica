# PlanetScale Postgres スキーマ baseline 生成ツールチェーン（Issue #691 Chunk 1）

親issue #664 / #568 Phase 2、子issue #665 の後続。`docs/planetscale-migration-audit.md`
（#665 migration移植監査）の結果を踏まえ、Supabaseの `public` スキーマを手作業のSQL Editor
貼り付けではなく再現可能なツールチェーンでPlanetScale向けbaselineへ変換する仕組みを実装した。

**本ドキュメントのステータス: Chunk 1（実Supabase認証情報を必要としない範囲）完了時点の記録。**
実Supabase DBへの接続はChunk 2で後日実施する。本ドキュメントの `db/planetscale/public-schema.sql`
は**ローカルDocker上のPostgreSQL 17（`postgres:17`イメージ、`supabase/migrations/` 71ファイル適用済み）
から採取したもの**であり、実Supabase prod/previewのデータではない。Chunk 2で実Supabaseに接続した
時点で本ファイルは再生成が必要になる（本ドキュメント末尾「Chunk 2 で行うこと」参照）。

## 1. 全体ワークフロー

```
1. export-public-schema.mjs   Supabase(または任意のPostgreSQL) DBから public スキーマを
                               schema-only dumpし、raw dump + manifest.json を生成する
2. normalize-schema.mjs        raw dump を安全な baseline SQL へ正規化する
                               （\restrict除去、publicスキーマ自身の再作成文除去、
                               防御的なauth/realtime/storage混入チェック・owner/ACL除去）
3. bootstrap.sql の適用        拡張機能・Supabase互換ロール・auth関数スタブを用意する
4. baseline (public-schema.sql) の適用
                               3の後に適用する（policy等がbootstrap側のオブジェクトを
                               参照するため順序が重要）
5. grants.sql の適用           service_role への実行権限GRANT（baseline適用後、
                               ALL TABLES/FUNCTIONS IN SCHEMA public を対象にするため
                               baseline より後に適用する必要がある）
6. 検証                        テーブル数・関数数・トリガー数等が期待値と大きく
                               乖離しないことを確認する
```

### 1.1 実行コマンド

```bash
# 1. 採取（DATABASE_URLは対象PostgreSQLへの接続文字列。環境変数でのみ受け付ける）
DATABASE_URL="postgres://..." node scripts/db-phase2/export-public-schema.mjs
# -> db/planetscale/.artifacts/public-schema.raw.sql
# -> db/planetscale/.artifacts/manifest.json

# 2. 正規化
node scripts/db-phase2/normalize-schema.mjs
# -> db/planetscale/public-schema.sql （既定の入出力パスは export の既定出力と対応済み）

# 3〜5. 適用（psql の場合の例。対象は空のPlanetScale論理DB、または検証用の空DB）
# `-1`（`--single-transaction`）が必須（下記の重要な注意参照）。
psql "$PLANETSCALE_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/planetscale/bootstrap.sql
psql "$PLANETSCALE_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/planetscale/public-schema.sql
psql "$PLANETSCALE_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/planetscale/grants.sql
```

`db/planetscale/.artifacts/` はDATABASE_URLの採取のたびに再生成される作業ディレクトリのため
`.gitignore` 対象（機密情報は含まないが、実行のたびに内容・digestが変わりうる生成物のため）。
`db/planetscale/public-schema.sql` / `bootstrap.sql` / `grants.sql` はコミット対象。

**重要: `psql -f` で `public-schema.sql` を適用する場合、`-1`（`--single-transaction`）が
必須（M-5対応後、Fableレビュー再検証で実際に発見・修正した問題）。**
`normalize-schema.mjs`はM-5対応（後述3.6節）でpreambleのセッションスコープ設定
（`SET x = y;`）を`SET LOCAL x = y;`へ、`set_config(..., false)`を`set_config(..., true)`
（トランザクションローカル）へ書き換えるようになった。これは `db-migrate.js` が
`migration-transaction: required`宣言のファイルをファイル全体1トランザクションとして
実行する（`sql.begin()`）ことを前提にした修正だが、**`-1`無しの`psql -f`は個々の文を
自動コミットで逐次実行するため、`SET LOCAL`/`set_config(...,true)`が「トランザクション
ブロック外」として即座に無効化される**（`SET LOCAL`は`WARNING: SET LOCAL can only be
used in transaction blocks`を出して無視され、`set_config(...,true)`は警告無しで
次の文には引き継がれない）。実機確認: `-1`無しで`public-schema.sql`を適用すると、
`check_function_bodies`がデフォルト値`on`のまま残り、後方のテーブルを参照する関数
（`exchange_duplicate_card_for_stones`等）の`CREATE FUNCTION`が
`relation "card_stone_transactions" does not exist`で失敗することを確認した。
`-1`を付けてファイル全体を1トランザクションにすると、`db-migrate.js`と同じ
「ファイル全体が1トランザクション」という前提が揃い、`SET LOCAL`/`set_config(...,true)`が
正しく効いたままエラー無く完走することも確認済み。`bootstrap.sql`/`grants.sql`は
（pg_dump生成物ではなく手書きのため）本来`-1`が無くても問題は起きないが、
3ファイルとも同じ流儀で統一するため`-1`を付けている。

### 1.2 db/planetscale/migrations/ への組み込み（`--provider=planetscale`）

`scripts/db-migrate.js`（Issue #692）の provider-neutral migration runner にそのまま乗せる方針
のため、bootstrap.sql と public-schema.sql の内容は下記2ファイルとしても
`db/planetscale/migrations/` に配置している（`-- migration-providers: planetscale` ヘッダー付き）:

- `db/planetscale/migrations/20260719180000_planetscale_bootstrap.sql`
  （`db/planetscale/bootstrap.sql` と同一内容 + ヘッダー）
- `db/planetscale/migrations/20260719180100_planetscale_public_schema_baseline.sql`
  （`db/planetscale/public-schema.sql` と同一内容 + ヘッダー。ファイル名の日時が
  bootstrapより後のため、ファイル名昇順で自然にbootstrap→baselineの順になる）

**注意（N-6、Fableレビュー2回目）: `db/planetscale/migrations/` はCIの静的チェック対象外**。
`scripts/check-migration-order.js`（`npm run check:migration-order`）と
`tests/unit/migration-filenames.test.ts`は、いずれも`supabase/migrations/`のみを対象に
ファイル名の連番・重複を検証しており、`db/planetscale/migrations/`はスキャンしない
（前者は`MIGRATIONS_DIR`が`supabase/migrations`に固定、後者も同ディレクトリを
`readdirSync`している）。現状このディレクトリは2ファイル固定のため実害は無いが、
将来ファイルが増える場合はファイル名の命名規則・昇順の整合性を**手動で**注意すること
（本節で説明した「ファイル名昇順で自然に適用順になる」という前提が、機械チェック無しに
運用者の注意力だけで担保されている状態）。専用の静的チェックを新設するかどうかは、
実際にファイルが増えた時点で改めて判断する（YAGNI、現時点では過剰実装と判断）。

**`supabase/migrations/` には置かない（Fableレビュー C-1、重要）**: 当初この2ファイルは
`supabase/migrations/` に配置していたが、`.github/workflows/deploy-cloudflare.yml` の
`Apply Supabase migrations` ステップが実行する `supabase db push --db-url "$SUPABASE_DB_URL"
--yes` は `supabase/migrations/` 配下の未適用ファイルをSupabase CLIの判断で**全て**適用する。
Supabase CLIは本プロジェクト独自の `-- migration-providers: planetscale` ヘッダーコメントを
解釈しない（ただのSQLコメントとして無視される）ため、`supabase/migrations/` に置いたままだと
次回デプロイで実Supabase preview/prodへ誤適用される（service_role等の実オブジェクトと衝突し、
権限エラーでデプロイ全体を止めるか、最悪RLSを壊す）リスクがあった。`db/planetscale/migrations/`
はSupabase CLIが一切スキャンしないディレクトリのため、この誤適用経路そのものを構造的に無くす。

`scripts/db-migrate.js` は `--provider=planetscale` 実行時のみ、`supabase/migrations/`
（共通/Supabase向け）と `db/planetscale/migrations/`（本ディレクトリ）の両方から
migrationファイルを読み込み、ファイル名（バージョン文字列）昇順でマージして扱う
（`resolveMigrationsDirs()` が対象ディレクトリを決定し、
`scripts/lib/db-migrate-core.js` の `loadMigrationFilesFromDirs()` がマージ・ソートする）。
`--provider=supabase`（既定）実行時は `supabase/migrations/` のみを見るため、
`db/planetscale/migrations/` の存在自体を意識しない。

`migration-providers: planetscale` 宣言は、ディレクトリ分離と併せた多重防御として維持している
（`--provider=planetscale` 実行時に万一 `supabase/migrations/` 側にも同種のファイルが
誤って置かれた場合の保険。`isProviderApplicable()`、`scripts/lib/db-migrate-core.js`）。
**Supabase本番/preview DBへは絶対に適用しないこと**（`service_role` 等の実オブジェクトと
衝突する）。

既存71ファイル（00001〜20260718140000、`supabase/migrations/`）は `migration-providers` を
宣言していない（＝全provider対象がデフォルト）ため、`--provider=planetscale` で見ると
「未適用」として検出される。これらは実際には baseline（上記2ファイル）が内容を代替済みのため、
再実行せず「適用済みとして登録する」ために `--bootstrap` モードを使う:

```bash
# 事前に db/planetscale/bootstrap.sql → public-schema.sql → grants.sql を
# 直接適用済み（1.1節の3〜5）のPlanetScale DBに対して実行する。
# 「実DBは既にこの内容を反映済み」という前提のもと、SQLを実行せずhistoryにのみ登録する。
DATABASE_URL="$PLANETSCALE_DATABASE_URL" node scripts/db-migrate.js apply --bootstrap --provider=planetscale
```

**`--confirm-fresh-apply` はこの定型コマンドに含めないこと（N-4、Fableレビュー2回目で修正）**:
`scripts/db-migrate.js`の`shouldBlockFreshApply()`は`bootstrap`が`true`の場合、他の引数を
見るより前に即座に`false`（ブロック不要）を返す実装になっている。つまり`--bootstrap`が
指定されている時点で`--confirm-fresh-apply`は判定に一切関与しない完全な無意味な指定であり、
以前の版でこのコマンド例に含めていたのは誤りだった。さらに、この定型コマンドをコピーして
使う運用者が誤って`--bootstrap`だけを外してしまった場合、`--confirm-fresh-apply`が
そのまま残っていると「history テーブルが存在しない新規DBに対して5件以上のpending
migrationがある状態でも確認なしに通常applyを実行してよい」というガード
（`FRESH_APPLY_PENDING_THRESHOLD`、Issue #692 Medium-1）を無条件に迂回してしまい、
73件のSQLが実際に適用される事故につながる。このガードは「`--bootstrap`を付け忘れた」
という事故そのものを検知するためのものであり、定型コマンドの側であらかじめ迂回指定を
足しておく理由が無いため削除した。`--bootstrap`無しであえて全件applyしたい場合
（通常運用では想定しない）にのみ、その時点で`--confirm-fresh-apply`を個別に検討すること。

この手順を実行後、`db-migrate.js status --provider=planetscale` で
「適用済み: 73件、未適用: 0件」になることをDocker実機検証で確認済み（4章参照）。
以降、PlanetScale向けの新規migrationは通常の `apply --provider=planetscale`
（`--bootstrap` 無し）で追加していける。

**「pending 73件」の成立条件について（N-7、Fableレビュー2回目で明記）**: 上記の「73件」は
既存71ファイル（`00001`〜`20260718140000`）+ bootstrap + baseline の合計だが、この73件を
**まっさらなDBへ`--bootstrap`無しの素の`apply --provider=planetscale`で実行することはできない**。
ファイル名は `00001` < `20260718140000` < `20260719180000`（bootstrap）の順でソートされる
（数字プレフィックスの文字列比較のため）ため、実行順は既存71ファイルが先、bootstrap.sqlが
最後になる。既存71ファイルはSupabase固有の`auth.uid()`・`anon`/`service_role`ロール等
（bootstrapが用意するはずのオブジェクト）に依存しているため、bootstrap.sqlより先に実行される
`00001`が「role/schemaが存在しない」で必ず失敗する。したがって「73件」という数え方・
「pending 0件」という到達状態は、実際には**本節記載の規定フロー（psqlで
bootstrap→baseline→grantsを手動適用 →`--bootstrap`で履歴登録）でのみ成立する**ものであり、
`db-migrate.js`の通常applyの実行順序どおりに73件を素通しできるという意味ではない。

**運用上の注意（C-1再検証で新たに判明、必ず読むこと）**: `twica_meta.schema_migrations`
はDB単位（provider単位ではない）の単一テーブルである。上記手順でPlanetScale DBに
`--provider=planetscale`で73件をbootstrap登録した**そのDATABASE_URLに対して**、
誤って`--provider=supabase`（`--provider`省略時のデフォルト値でもある）で
`status`/`plan`/`apply`/`verify`を実行すると、`20260719180000`/`20260719180100`の
2件が「historyには存在するが、supabase provider用のディレクトリ集合
（`supabase/migrations/`のみ）には対応するファイルが無い」ため
`missingFiles`（整合性エラー）として検出され、**exit 1でブロックされる**ことを
Docker実機検証で確認した（意図的な設計: 黙って進めず、provider指定の取り違えに
気付けるようにする安全側の挙動。詳細は`scripts/lib/db-migrate-core.js`の
`diffMigrationState`参照）。これはバグではなく、「1つのDATABASE_URLに対しては
常に対応するproviderを明示指定する」運用規律を守っている限り発生しない
（PlanetScale DBには常に`--provider=planetscale`、Supabase DBには常に
`--provider=supabase`または省略）。`--provider`のデフォルトが`supabase`であることを
踏まえ、**PlanetScale DBに対して`db-migrate.js`を実行する際は必ず
`--provider=planetscale`を明示すること**（省略時デフォルトへの依存は事故のもと）。

## 2. `db/planetscale/public-schema.sql` の位置づけと、5.1節（pg_dump -Fc/pg_restore）との関係

**重要: 本チャンクのbaseline生成と、`docs/db-phase2-runbook.md` 5.1節にある本番カットオーバー
時の `pg_dump -Fc`/`pg_restore` 手順は別物である。**

| | 本チャンク（`db/planetscale/`ツールチェーン） | `docs/db-phase2-runbook.md` 5.1節 |
|---|---|---|
| 目的 | D-day前の準備・ツール検証 | D-day当日の実データ移送 |
| pg_dump形式 | `--schema-only`（データを含まない） | `-Fc`（custom format、データを含む） |
| 対象 | スキーマ定義のみ | 「その時点の」実データ込みprod |
| 実行タイミング | 何度でも（preview検証・drift検知等） | D-day当日1回のみ |
| 生成物 | `db/planetscale/public-schema.sql`（git管理） | `.dump`ファイル（一時生成物、git管理しない） |

D-day当日は改めて5.1節の手順で「その時点の」実データ込みprodを`pg_dump -Fc`/`pg_restore`する。
本チャンクで作ったtoolingはD-day当日にも次の用途で再利用できる:

- **schema-onlyでの事前検証**: `export-public-schema.mjs` を使い、D-day直前に実Supabase
  prodのpublicスキーマを採取して`normalize-schema.mjs`にかけ、想定通りのオブジェクト数
  （テーブル/関数/トリガー/インデックス/ポリシー）になっているかをリハーサルできる。
- **driftチェック**: `manifest.json` のオブジェクト種別ごとの件数を、過去の採取結果や
  `docs/db-phase2-runbook.md` 1章の想定値と突き合わせることで、意図しないスキーマ変更が
  無いかを機械的に確認できる。

実データの移送そのものは引き続き5.1節の `pg_dump -Fc`/`pg_restore` が担う。本チャンクの
`bootstrap.sql`/`grants.sql`（ロール・拡張機能・権限セットアップ）は、5.1節の手順4.5
（ロール/スタブ関数の事前投入）・手順5後の権限セットアップとしてもそのまま再利用できる設計にした
（`docs/db-phase2-runbook.md` 5.1節の手順4.5に書かれたSQLと `db/planetscale/bootstrap.sql`
の内容は同一のものを冪等化しただけ）。

## 3. 実装時に判明した技術的な注意点（Docker実機検証で発見）

### 3.1 `\restrict` / `\unrestrict` メタコマンド

PostgreSQL 17.6以降の`pg_dump`は、出力の冒頭・末尾に`\restrict <token>` /
`\unrestrict <token>`というpsql専用メタコマンドを付与する。**実機確認: `postgres:17`
Dockerイメージのpg_dump 17.10で実際に出力されることを確認した**（`\restrict` 1件・
`\unrestrict` 1件、常にペアで出力される）。これはSQL文ではなくpsqlのバックスラッシュ
コマンドのため、`postgres`（porsager/postgres、本リポジトリが使うSQLクライアント）等の
非psqlクライアント経由で実行すると構文エラーになる。`normalize-schema.mjs`の
`stripRestrictMetacommands()`が常に検出・除去する。

### 3.2 `public` スキーマ自身の再作成文

`pg_dump --schema=public` は常に `CREATE SCHEMA public;` と
`COMMENT ON SCHEMA public IS 'standard public schema';` を出力に含める。しかし
`public` スキーマはPostgreSQLの`initdb`が作成する既定スキーマであり、新規DB
（PlanetScaleの新規論理DBを含む）には最初から存在する。**実機確認: これを素通しすると
`ERROR: schema "public" already exists` で適用が失敗する**ことを確認した
（`ON_ERROR_STOP=1`付き`psql -f`での検証）。`normalize-schema.mjs`はこの2ブロックを
`exclude`（reason: `public-schema-preexists`）として除外する。

### 3.3 `pgcrypto` の設置スキーマ（`extensions`スキーマ問題）

`00073_add_analysis_dashboard_rpcs.sql`（#716で修正）は`pgcrypto`の`digest()`関数を
`extensions.digest(...)`とスキーマ修飾して呼び出している（Supabase実運用での`pgcrypto`の
実際の設置場所=`extensions`スキーマに合わせた修飾）。**実機確認: `pgcrypto`をpublicスキーマへ
無修飾でインストールすると、baseline適用時に`ERROR: schema "extensions" does not exist`で
該当関数の作成が失敗する**ことを確認した。`db/planetscale/bootstrap.sql`は
`CREATE SCHEMA IF NOT EXISTS extensions;` の上で
`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;`とすることでこれを回避する。
`uuid-ossp`側もbaseline（`db/planetscale/public-schema.sql`）内のDEFAULT句に
`public.uuid_generate_v4()`とスキーマ修飾された形で現れる（pg_dumpがdump元DBでの実際の
インストール先を解決して埋め込むため）。**当初 `WITH SCHEMA` を省略していたが
（＝現在のsearch_pathの先頭スキーマへ依存する）、Fableレビュー(M-4)で
「PlanetScale側でsearch_pathがSupabaseと異なる場合、publicに入らず修飾呼び出しが失敗しうる」
との指摘を受け、実機再現・修正確認した**: Docker上でsearch_pathを`extensions, public`に
設定した状態で`WITH SCHEMA`無しの`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`を実行すると
拡張機能が`extensions`スキーマへインストールされ、`SELECT public.uuid_generate_v4();`が
`function public.uuid_generate_v4() does not exist`で実際に失敗することを確認した。
`db/planetscale/bootstrap.sql`は`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;`
と明示する形に修正し、同条件で成功することも確認済み。pgcryptoと同様にスキーマを明示する
非対称にならない扱いとした（詳細は`db/planetscale/bootstrap.sql`内のコメント参照）。

### 3.4 TOCブロックのオブジェクト種別（実測、`postgres:17`・pg_dump 17.10）

`supabase/migrations/` 71ファイル適用後のDBに対する`--schema=public --schema-only
--no-owner --no-privileges`実測値（Docker検証、4章参照）:

| Type | 件数 |
|---|---|
| TABLE | 25 |
| FUNCTION | 28 |
| TRIGGER | 11 |
| INDEX | 53 |
| CONSTRAINT | 35 |
| FK CONSTRAINT | 26 |
| POLICY | 29 |
| ROW SECURITY | 25 |
| COMMENT | 55 |
| SCHEMA | 1（`public`自身。exclude対象） |

`--no-owner --no-privileges`により`ACL`/`OWNER`種別のブロックは1件も出力されなかった
（実測で確認）。`auth`/`realtime`/`storage`/`vault`/`supabase_migrations`スキーマの
オブジェクトも`--schema=public`により1件も混入しなかった（実測で確認）。
`normalize-schema.mjs`の`exclude`ロジック（auth等の混入防止・owner/ACL防止）はこのため
実際のpg_dump出力に対しては0件しか除外しない（`public`スキーマ自身の2ブロックを除く）。
これは想定通り: これらの防御ロジックは「`--schema=public --no-owner --no-privileges`が
正しく効いていることを前提にしない、二重の安全網」であり、フラグが正しく機能している限り
発動しないことこそが正しい状態。防御ロジック自体の動作は
`tests/unit/db-phase2/normalize-schema.test.ts`のfixtureベーステストで別途検証している。

### 3.5 `compat-bootstrap` カテゴリについて

`normalize-schema.mjs`は`bring-as-is`/`compat-bootstrap`/`exclude`の3カテゴリを持つが、
`--schema=public`の性質上（`auth`スキーマの関数もロードもクラスタ/別スキーマのオブジェクトで
public スキーマのdump範囲に含まれない）、実際のpg_dump出力に対して`compat-bootstrap`へ
分類されるオブジェクトは存在しない（実測: 0件）。role スタブ・auth関数スタブに相当する内容は
`db/planetscale/bootstrap.sql`に手書きで用意する別枠であり、pg_dump出力をパースして
機械的に導出するものではない。RLS policyが`auth.uid()`や`service_role`を参照していても、
bootstrap.sqlがbaselineより先に適用される前提のため、policy自体は`bring-as-is`として
そのまま持ち込む設計にしている（詳細は`normalize-schema.mjs`冒頭コメント参照）。

### 3.6 preambleのセッションスコープ設定とトランザクション境界（M-5対応、Fableレビュー）

`db-migrate.js`は単一コネクション（`max: 1`。advisory lockがセッションスコープのため）で
複数migrationファイルを順に適用する設計であり、pg_dumpのpreambleが出力する
`SELECT pg_catalog.set_config('search_path', '', false);`はセッションスコープ（is_local=false）
のため、baseline適用後のCOMMIT後もその接続に残り続け、後続のPlanetScale向けmigrationが
`search_path=''`のまま実行されて非修飾テーブル参照が失敗しうる、という指摘を受けた。

`normalize-schema.mjs`の`neutralizePreambleSessionScope()`は、**preamble中に限り**
`set_config(..., false)`を`set_config(..., true)`（トランザクションローカル）へ、
LOCAL指定の無い素の`SET x = y;`を`SET LOCAL x = y;`へ書き換えることでこれに対処した。
`SET LOCAL`/`set_config(...,true)`はトランザクションのcommit/rollbackと同時に自動的に
元へ戻るため、`db-migrate.js`が1ファイルを1トランザクション（`migration-transaction:
required`宣言、`sql.begin()`）として実行する限り、ファイル内では正しく効きつつ、
preambleで検出された対象文に限り後続ファイルへは漏れなくなる。

**適用範囲の限界（N-3、Fableレビュー2回目で指摘）**: この書き換えはpreamble部分のみが
対象で、`public-schema.sql`本文（各TOCブロックの中）に現れる同種のセッションスコープ文
までは対象にしていない。実際、pg_dumpはブロックの区切りとして`SET default_tablespace = '';`
／`SET default_table_access_method = heap;`という素の（LOCAL指定の無い）SET文を出力しており
（本ファイル内、最初の`CREATE TABLE`直前に実在する）、これらは理論上preamble側と同じ
「セッションスコープのまま後続migrationへ漏れる」パターンに該当する。ただし出力される値
（`''`／`heap`）はいずれもPostgreSQLのデフォルト値と同一のため、漏れても後続migrationの
実際の挙動は変わらず、現状は実害が無いことを確認済み。「後続ファイルへは一切漏れなくなる」
という以前の説明はこの限界を踏まえていなかったため、本節と`neutralizePreambleSessionScope()`
のJSDocの両方を「preambleのみが対象」と明記する形に修正した。対象範囲を広げる判断は
将来pg_dumpの出力仕様が変わった場合に再検討する（詳細は同関数のJSDoc参照）。

**重要な副作用（実機再検証で新たに発見）**: この書き換えにより、`public-schema.sql`は
**「ファイル全体が1つのトランザクションとして実行される」ことに依存するSQLになった**。
`db-migrate.js`経由（`migration-transaction: required`）では常にこの前提が成り立つが、
**`psql -f`をトランザクションラップ無しで実行すると壊れる**ことをDocker実機で確認した:
`-1`（`--single-transaction`）無しで`psql -v ON_ERROR_STOP=1 -f db/planetscale/public-schema.sql`
を実行すると、`SET LOCAL`各行が`WARNING: SET LOCAL can only be used in transaction
blocks`を出して無視され（`set_config(...,true)`も警告無しで同様に次の文へ引き継がれない）、
特に`check_function_bodies`がPostgreSQLのデフォルト値`on`のまま残ってしまう。
その結果、後方で定義されるテーブルを参照する関数（`exchange_duplicate_card_for_stones`等）の
`CREATE FUNCTION`が`relation "card_stone_transactions" does not exist`で実際に失敗することを
確認した。`-1`を付けてファイル全体を1トランザクションにすると、`db-migrate.js`と同じ
「ファイル全体が1トランザクション」という前提が揃い、エラー無く完走し、オブジェクト数も
source側と完全一致することを確認済み（4.1節手順6〜7、`psql -f -1`経由での検証記録）。
1.1節の手動適用コマンドには`-1`を必須として明記している。

**訂正（N-7、Fableレビュー2回目）**: 以前の版は「db-migrate.js経由の適用と同様にオブジェクト数が
一致することを確認済み」と記載していたが、これは不正確だった。4.1節の検証は
`psql -f -1`（1.1節の手動適用コマンド）でbootstrap.sql→public-schema.sql→grants.sqlを
適用したものであり、`db-migrate.js apply`（実SQL実行を伴う通常のapply）で実際にこの3ファイルを
適用した記録は無い（4.1節手順9で行っているのは`--bootstrap`モードのみで、これは設計上
「実行せずhistoryに登録するだけ」であり実SQLを実行しない）。「db-migrate.js経由の適用と
同様に」という表現は、両者が「ファイル全体を1トランザクションとして扱う」という
トランザクション境界の前提を共有している、という意味で書いたものだったが、実際に
db-migrate.js経由でSQLを実行し検証したかのように読めてしまうため削除した。

## 4. ローカルDocker実機検証

`docs/planetscale-migration-audit.md`の付記手順を流用し、認証情報なしでエンドツーエンドの
ツールチェーン動作を検証した。

### 4.1 手順と結果

1. **sourceコンテナ起動**: `docker run -d --name twica-pg2-source -e POSTGRES_PASSWORD=devpass
   -p 5434:5432 postgres:17`（ポート5434、既存コンテナと衝突なしを`docker ps`で確認）
2. **Supabase互換ダミー投入 + 71ファイル適用**: `auth`/`realtime`スキーマダミー、
   `anon`/`authenticated`/`service_role`ロールダミー、`extensions`スキーマ+`pgcrypto`
   （3.3節の対処を反映）を投入した上で、`supabase/migrations/`の71ファイルを
   ファイル名順に`psql -f -v ON_ERROR_STOP=1`で適用 → **71ファイル全て成功**。
   `00051_add_card_owner_stats.sql`適用時に想定通り
   `WARNING: SET LOCAL can only be used in transaction blocks`を実測確認
   （`docs/planetscale-migration-audit.md` 3.1節と一致。`scripts/lib/db-migrate-core.js`
   のforbidden+SET LOCALガード追加の直接的な実測根拠）。
3. **export-public-schema.mjs実行**: sourceコンテナに対して実行 →
   `public-schema.raw.sql`（118,684 bytes）+ `manifest.json`を生成。
   `postgresMajorVersion: 17`、`objectCounts`は3.4節の表と一致、
   `artifactSha256`を記録、manifestに接続文字列・ホスト名が含まれないことを確認。
4. **normalize-schema.mjs実行**: raw dumpを正規化 →
   `\restrict/\unrestrict`除去2件、`bring-as-is`286件、`exclude`2件
   （`public`スキーマ自身のみ）、`compat-bootstrap`0件。出力`public-schema.sql`
   （3,832行）を生成。
5. **targetコンテナ起動**: `docker run -d --name twica-pg2-target -e POSTGRES_PASSWORD=devpass
   -p 5435:5432 postgres:17`（**まっさらな空DB**、supabase/migrationsは一切適用していない）
6. **bootstrap.sql → public-schema.sql → grants.sql の順に適用**: 3ファイルとも
   `ON_ERROR_STOP=1`でエラー・WARNING無しで完走。
7. **オブジェクト数の突き合わせ**: targetコンテナのテーブル数・トリガー数・ポリシー数・
   インデックス数がsourceコンテナと完全一致することを確認:

   | 確認項目 | source (71migration適用) | target (bootstrap+baseline+grants適用) |
   |---|---|---|
   | テーブル数 | 25 | 25 |
   | トリガー数（内部トリガー除く） | 11 | 11 |
   | ポリシー数 | 29 | 29 |
   | インデックス数 | 88 | 88 |
   | 拡張機能 | uuid-ossp, pgcrypto | uuid-ossp, pgcrypto, plpgsql |
   | 互換ロール | anon, authenticated, service_role（ダミー） | anon, authenticated, service_role（bootstrap.sql由来） |

8. **bootstrap.sql / grants.sqlの冪等性確認**: 適用済みのtargetコンテナへ両ファイルを
   再実行 → `NOTICE: extension "uuid-ossp" already exists, skipping`等の無害なNOTICEのみ、
   exit code 0で成功（実PlanetScale prod/previewに既にロールが作成済みという
   issue #691本文の前提に対応）。
9. **db-migrate.js統合確認**: targetコンテナに対して
   `db-migrate.js status --provider=planetscale` → 「適用済み: 0件、未適用: 73件」を確認
   （71既存ファイル+bootstrap+baseline）。
   `apply --bootstrap --provider=planetscale --confirm-fresh-apply` を実行（当時の実行ログ、
   `--confirm-fresh-apply`は`--bootstrap`指定時は無意味と後日判明したため1.2節の定型コマンド
   からは削除済み。本項は実際に実行したコマンドの記録として残す） →
   73件全てが`bootstrapped`として履歴登録され、`verify --provider=planetscale` で
   「適用済み: 73件、未適用: 0件」を確認。既定の`--provider=supabase`では
   bootstrap/baselineの2ファイルが`provider不一致でスキップ`と表示されることも確認
   （provider分離が正しく機能している）。
10. **後片付け**: 検証完了後、`docker rm -f twica-pg2-source twica-pg2-target`で
    両コンテナを削除済み。

### 4.2 単体テスト

`npm run test:unit`（vitest）で以下を実行し、全件成功（既存2752件 + 新規テスト含む）:

- `tests/unit/db-phase2/normalize-schema.test.ts`（24件）: TOCブロック分割・分類・
  round-trip不変条件・`\restrict`除去・fixtureスナップショット
- `tests/unit/db-phase2/export-public-schema.test.ts`（7件）: manifest組み立て・
  PostgreSQLバージョン抽出・機密情報非混入
- `tests/unit/db-migrate-core.test.ts`（追記分）: `containsSetLocal`・
  `migration-transaction: forbidden`+`SET LOCAL`併用検知ガード・
  `00051_add_card_owner_stats.sql`実ファイルに対する回帰テスト

## Chunk 2 で行うこと（本チャンクのスコープ外）

- 実Supabase prod/preview DBの Direct connection を使い、`export-public-schema.mjs`で
  実データのpublicスキーマを採取し、`db/planetscale/public-schema.sql`を実データベースで
  再生成する（本ドキュメント時点のファイルはDocker検証用の暫定版）。
- prod/previewそれぞれのmanifest.jsonを比較し、意図しない差分を一覧化する
  （Issue #691元本文「本番とpreviewを別artifactとして比較」）。
- 実PlanetScale prod/preview DBへ`bootstrap.sql`→`public-schema.sql`→`grants.sql`を適用し、
  実機で動作確認する（Docker検証だけでは完了扱いにしない、Issue #691元本文の受け入れ条件）。
- **拡張機能の設置スキーマの実測確認・是正（N-5、Fableレビュー2回目）**: 実PlanetScale
  prod/preview（`bluemoon-works`/`twica`）には、本チャンクでの`bootstrap.sql`修正（3.3節、
  `WITH SCHEMA public`の明示追加）**より前**の版（`WITH SCHEMA`無し）の手動SQLが
  2026-07-19にWeb Console経由で既に適用されている。今回のbootstrap.sql修正は今後の新規適用
  （まっさらなDBへの適用）には効くが、既に適用済みの実環境では`uuid-ossp`拡張が
  `search_path`次第で`public`以外のスキーマにインストールされてしまっている可能性がある。
  Chunk 2で実PlanetScale DBに接続した際、baseline適用前に必ず次のクエリで実測確認すること:
  ```sql
  SELECT extname, extnamespace::regnamespace
  FROM pg_extension
  WHERE extname IN ('uuid-ossp', 'pgcrypto');
  ```
  `uuid-ossp`の`extnamespace`が`public`以外だった場合（`pgcrypto`は`extensions`が正のため
  それ以外であれば同様に是正）、baseline側の`public.uuid_generate_v4()`修飾呼び出しが
  `function public.uuid_generate_v4() does not exist`で失敗するため、baseline適用前に
  以下で是正する:
  ```sql
  ALTER EXTENSION "uuid-ossp" SET SCHEMA public;
  ```
- `src/lib/db/schema.ts`・実Supabase・PlanetScale baselineの3者比較によるschema drift検証
  （Issue #691元本文タスク5、既知ドリフト#625含む）。
- **manifest.json に migration history の最大version（Fableレビュー M-7）を追加する**:
  Issue #691本文が要求する項目だが、`export-public-schema.mjs`は`pg_dump`しか実行しないため
  取得経路が無い（`twica_meta.schema_migrations`はDB接続が別途必要）。Chunk 2で実Supabase/
  PlanetScaleへのDB接続経路を実装する際、`export-public-schema.mjs`（またはその呼び出し元）に
  `select max(version) from twica_meta.schema_migrations`相当のクエリを追加し、
  `buildManifest()`の引数・出力に`maxAppliedMigrationVersion`のようなフィールドを追加すること。
  この対応が漏れたまま受け入れ完了としないこと。
- **grants.sqlの`ALTER DEFAULT PRIVILEGES`にFOR ROLEを明示する（Fableレビュー M-3の後続）**:
  `db/planetscale/grants.sql`のコメントに記載の通り、Chunk 1時点では実PlanetScaleでmigrationを
  適用する管理ロール名が未確定のため`FOR ROLE`句を意図的に省略している。Chunk 2でPlanetScale
  接続・実際の管理ロール運用が確定した時点で、`FOR ROLE <確定ロール名>`を明示すること
  （`twica_app`はCREATEROLE権限を持たずbootstrap.sql自体を適用できないロールのため対象外。
  詳細はgrants.sql内コメント参照）。
- **baseline再生成時のchecksum衝突運用手順（Fableレビュー M-8 → N-1で更新）**: `db-migrate.js`の
  `twica_meta.schema_migrations`はversionごとにchecksumを1つだけ記録し、一度
  `apply`/`--bootstrap`で登録されたversionのchecksumは変更できない（ファイル内容を書き換えると
  checksum不一致として即エラー終了する。`scripts/lib/db-migrate-core.js`の
  `parseDescriptorHeader`コメント内の申し送り参照）。したがって実Supabaseから
  `db/planetscale/public-schema.sql`を再生成した結果、既存の
  `20260719180100_planetscale_public_schema_baseline.sql`（Chunk 1時点でDocker検証用データから
  生成・`--bootstrap`で履歴登録済みの想定）の内容と差分が生じた場合、**同じファイルを
  上書きしてはいけない**。代わりに以下の手順を踏むこと:
  1. 新しいバージョン番号（採取日時ベースのタイムスタンプ、例:
     `db/planetscale/migrations/<YYYYMMDDHHMMSS>_planetscale_public_schema_baseline_v2.sql`）で
     別ファイルとして追加する。
  2. 旧ファイル（`20260719180100_...`）は履歴に残したまま削除・変更しない
     （既に`--bootstrap`で登録済みの環境でchecksum不一致エラーを起こさないため）。
  3. 新ファイルの内容は「旧baseline適用後のDBに対して、差分のみを反映するDDL」
     （新規テーブル/カラム追加・変更等）として書く。単純に新しい全体dumpをそのまま
     新ファイルにすると、既存オブジェクトへの`CREATE TABLE`等が重複エラーになるため、
     素の全体dump差し替えはできない。
  4. `db/planetscale/public-schema.sql`（正本）自体は最新の全体dump内容に更新してよいが、
     これは「次にまっさらなDBへ新規適用する場合の正本」という位置づけであり、
     既に運用中の環境には上記2〜3の差分migrationで追従させる。
  5. **（N-1追加）`tests/unit/db-phase2/migration-sync.test.ts`に、新しいmigrationファイル用の
     `it.each`エントリ（ファイル名 → 本体のsha256ハッシュ）を追記する。既存の
     `20260719180000`/`20260719180100`エントリは変更しない（変更すると、まさに上記2で
     禁止している「登録済みファイルへの変更」を検知できなくなってしまう）。**

  **N-1（Fableレビュー2回目・設計変更の経緯）**: 当初の`migration-sync.test.ts`は
  「正本（`db/planetscale/{bootstrap,public-schema}.sql`）とmigrationコピーのバイト一致」を
  検証していたが、これは上記手順4（正本は自由に再生成してよい）と正面から矛盾していた:
  Chunk 2で正本を正しく再生成した瞬間にこのテストは必ず落ち、しかも「テストを緑に戻す」ために
  最も自然に見える操作（コピー側を正本に合わせて上書きする）が、上記手順2で禁止している
  「checksum登録済みファイルの書き換え」と一致してしまうという危険な誘導になっていた。
  対応として、テストの検証対象を「正本の現在の内容」から「Chunk 1時点で固定したsha256
  ハッシュ」に変更した（本節冒頭の設計変更に合わせ、`tests/unit/db-phase2/migration-sync.test.ts`
  冒頭コメント参照）。正本ファイルの全文コピーを新たなfixtureとして別途保持する案（3つ目の
  全文コピーがリポジトリに増える）ではなく、sha256ハッシュのみをテストに埋め込む設計を選んだ
  理由はYAGNI: 目的は「意図しない書き換えの検知」であり、それにはハッシュの比較で十分で、
  実際に何が変わったかを知りたい場合は`git diff`でmigrationファイル自体の差分を見れば足りる
  （別ファイルでの全文フリーズはこの目的に対して過剰な実装と判断した）。
