# PlanetScale Postgres スキーマ baseline 生成ツールチェーン（Issue #691 Chunk 1 / Chunk 2）

親issue #664 / #568 Phase 2、子issue #665 の後続。`docs/planetscale-migration-audit.md`
（#665 migration移植監査）の結果を踏まえ、Supabaseの `public` スキーマを手作業のSQL Editor
貼り付けではなく再現可能なツールチェーンでPlanetScale向けbaselineへ変換する仕組みを実装した。

**本ドキュメントのステータス: Chunk 1（ツールチェーン実装・ローカルDocker検証）に続き、
Chunk 2（実Supabase本番への接続・実データでの再生成）の一部を実施した時点の記録。**
本ドキュメントの `db/planetscale/public-schema.sql` は、Chunk 1時点では**ローカルDocker上の
PostgreSQL 17（`postgres:17`イメージ、`supabase/migrations/` 71ファイル適用済み）から採取した
もの**だったが、Chunk 2で実Supabase本番（`export-public-schema.mjs`経由のDirect connection）
から再採取した実データに**置き換え済み**である（テーブル23・関数27・トリガー9等、既知の#625
ドリフト＝battles/battle_stats欠落を含む。詳細は本ドキュメント「Chunk 2 での bootstrap.sql /
public-schema.sql 直接更新について」節参照）。ただしChunk 2の全タスクが完了したわけではなく、
実PlanetScale prod/previewへの適用・prod/preview間のartifact比較等、複数の項目が未実施のまま
残っている（本ドキュメント末尾「Chunk 2 で行うこと」の各項目に実施状況を明記した）。

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

**注意**: 上記「未適用0件」はChunk 1〜2検証当時、対象ツリーに73件しか存在しなかった
（＝#788のmigrationファイルがまだ無かった）ために到達した状態である。下記の追記時点では
ツリーに74件目（#788分）が存在するため、「未適用0件」の意味が逆転する
（もはや「全件bootstrap完了」ではなく「#788まで誤ってbootstrapに巻き込んでしまった」
ことを意味する）。両者は矛盾ではなく、対象ツリーのファイル数が異なることによる違いである。

**重要（issue #788・CI自動化に伴う追記、本番未実施の場合は必ず読むこと）**:
本節の「73件」は本ドキュメント執筆時点（Chunk 1〜2）の`supabase/migrations/`ファイル数
（71件）+ bootstrap + baseline の合計である。その後 issue #788 で
`supabase/migrations/20260723150000_add_channel_points_capability.sql` が追加されたため、
現在の `--provider=planetscale` pending件数は **74件**（既存73 + 新規1件）になっている。

**`--bootstrap` は「実DBが既にその内容を反映済み」のmigrationにのみ使ってよい
（SQLを実行せず履歴にのみ登録するため）。`20260723150000_add_channel_points_capability.sql`
は本番PlanetScaleにまだ一度も適用されていない、実行が必要な真に新規のmigrationのため、
このファイルを`--bootstrap`で登録してはならない**。誤って含めてしまうと、
「履歴上は適用済み」なのに実際にはALTER TABLE/CREATE FUNCTIONが未実行という状態になり、
`src/lib/twitch/channel-points-access.ts`のdeploy-windowフォールバック
（列欠落を`capability: 'unknown'`へ静かに縮退させる設計）と組み合わさって、
**CIも赤くならず気付かれないまま該当機能が本番で恒久的に無効化される**事故につながる
（設計レビューで指摘されたCritical項目）。

本番でまだ一度も`--bootstrap`を実行していない場合、以下の手順で行う。

**重要（2回目のレビューで判明した罠の回避）**: bootstrap実行と検証を同じツリー
（同じ`git checkout`）で行ってはならない。`status`はその時点で**作業ツリーに存在する
ファイルしか見ない**ため、bootstrapを「`20260723150000`が存在しないツリー」で実行した後、
**同じツリーのまま**`status`を見ても「未適用0件」にしかならず、これは
`--bootstrap`が正しく73件だけを登録できた場合と、誤って#788を含むツリーで実行してしまい
74件登録してしまった場合の**両方で同じ表示になり、区別できない**。検証は必ず
`20260723150000`を含む別のツリーへ切り替えてから行うこと。

```bash
# 1. bootstrap対象のツリーを、ブランチ名（例: origin/main）ではなく固定コミットSHAで
#    明示的に指定する。ブランチ名は本PRのマージ後さらに main が進むと指す内容が
#    変わってしまうため、「今」#788を含まないことが確認済みの固定点を使う
#    （claude-reviewで指摘: ブランチ名指定は将来のmain進行に対して脆弱）。
#    2026-07-23時点でorigin/mainの最新コミットは 9066070dc7405e7b7b44eb153fa3558b4c3e1083
#    であり、これは#788を含まないことを確認済み（このコミット以前のどのmainコミットでもよい）。
git fetch origin main
git checkout 9066070dc7405e7b7b44eb153fa3558b4c3e1083
# 上記SHAが古くなっていた場合、または別のコミットを使う場合に備え、
# 実ファイルの有無による機械的な確認も必ず行う（ブランチ名同様、SHA直指定であっても
# 「この手順を書いた時点の情報が古いまま放置される」リスクは残るため、
# 最終防御としてコマンドで検証する）。
test -f supabase/migrations/20260723150000_add_channel_points_capability.sql && \
  { echo "NG: このツリーには#788のmigrationが既に含まれている。bootstrapしないこと"; exit 1; }
DATABASE_URL="$PLANETSCALE_DATABASE_URL" node scripts/db-migrate.js apply --bootstrap --provider=planetscale

# 2. 【必須】検証は #788 のmigrationファイルを含む別ツリー
#    （本CI自動化ブランチ、または#788昇格PRマージ後のmain）へ checkout し直してから行う。
git checkout <#788のmigrationファイルを含むコミット>  # 例: このブランチ、または昇格後のmain
DATABASE_URL="$PLANETSCALE_DATABASE_URL" node scripts/db-migrate.js status --provider=planetscale
#  -> 「未適用: 1件（20260723150000_add_channel_points_capability）」なら成功
#     （bootstrapが正しく73件のみを登録し、#788は真に未適用のまま残っている）。
#  -> 「未適用: 0件」なら失敗（#788が誤ってbootstrap時に巻き込まれている）。
#     続行せず、下記の復旧手順（DELETE）へ進むこと。
```

検証を通過すれば、以降は`20260723150000_add_channel_points_capability.sql`のみが
未適用として残る。この1件は、#788昇格PRをmainへマージした後の最初の本番デプロイで
`.github/workflows/planetscale-migrate.yml`が自動的に適用する（下記「CI自動化について」参照）。
今すぐ手動で適用したい場合は、#788を含むツリーのまま
`DATABASE_URL="$PLANETSCALE_DATABASE_URL" node scripts/db-migrate.js apply --provider=planetscale`
を追加実行してもよいが、CIジョブと同じ処理を先取りするだけなので必須ではない。

もし既にマージ後の`main`（#788を含む状態）に対して誤って`--bootstrap`を実行してしまい、
上記step 2の検証で「未適用: 0件」（失敗）と判明した場合は、`twica_meta.schema_migrations`
から`20260723150000`のversion行を手動DELETEしてから`apply --provider=planetscale`を
再実行することで復旧できる（`--bootstrap`は履歴登録のみでSQL実行を伴わないため、
この復旧操作自体に副作用は無い）。

**CI自動化について**: `.github/workflows/planetscale-migrate.yml`（production環境・
mainブランチのみが対象の独立workflow）が、`main`へのpush毎に`apply --provider=planetscale`
（`--bootstrap`無し）を自動実行する。上記のワンタイムbootstrapが完了していれば、以降の
新規migrationはこのworkflowが自動適用する。`--bootstrap`はワンタイム作業のためCIには
含めない。`deploy-cloudflare.yml`とは意図的に別ファイルに分離している
（理由は`planetscale-migrate.yml`冒頭コメント参照）。

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
`extensions.uuid_generate_v4()`とスキーマ修飾された形で現れる（pg_dumpがdump元DBでの実際の
インストール先を解決して埋め込むため）。**Chunk 1（ローカルDocker検証）時点では
`WITH SCHEMA public`が正しいという誤った前提でbootstrap.sqlを書いていたが、
Chunk 2で実Supabase本番へ接続しpg_dumpした結果、実際には`uuid-ossp`も`pgcrypto`と同じ
`extensions`スキーマにインストールされている（Supabaseプロジェクトの標準構成）ことが
判明した**。`db/planetscale/bootstrap.sql`は現在
`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;`
としており、pgcryptoと同じ`extensions`スキーマへ統一している（詳細な経緯・実機確認結果は
`db/planetscale/bootstrap.sql`内のコメントおよび本ドキュメントのN-5節参照）。

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

### 4.3 cutover検証ツールのDocker故障注入テスト（Issue #697、追記）

Issue #697「cutover前後のschema・件数・checksum・業務invariant検証ツール」の実装に伴い、
本章と同じ2コンテナ構成（source/target、`bootstrap.sql` → `public-schema.sql`の順で適用）を
使った故障注入統合テストを `tests/unit/db-cutover/docker-fault-injection.test.ts` に追加した。
`scripts/db-cutover/` 配下のLayer 1（identity検証）・Layer 2（schema比較）・CLI
（`verify.mjs`/`init-identity.mjs`）が実DB接続で意図通りfailを検出することを検証する。

**通常の `npm run test:unit`/`npx vitest run` では実行されない（自動スキップ）。**
CI環境（GitHub Actions ubuntu-latest）はDocker自体は確実に持つが、psql/pg_dumpの有無や
そのメジャーバージョンが本テストの起動する `postgres:17` イメージと一致するかは保証されて
いないため、CI全体（`--bail=1`付きのUnit testsステップ）を巻き添えにするリスクがある。
そのため明示的なopt-in環境変数を必須にしており、これが無い限りCIかローカルかを問わず
常にスキップする。

ローカルで実機検証する場合:

```bash
RUN_DB_CUTOVER_DOCKER_TESTS=1 npx vitest run tests/unit/db-cutover/docker-fault-injection.test.ts
```

前提条件（本章4.1節と同じ）: Docker Desktopが起動していること、`psql`/`pg_dump`が
PATH上またはHomebrewの既定インストール先（`/opt/homebrew/opt/postgresql@17/bin` 等）から
解決できること。opt-inした上で前提条件が揃っていない場合は、テスト実行時にその旨を示す
警告が出てスキップされる（サイレントに何も起きないわけではない）。

## Chunk 2 で行うこと（本チャンクのスコープ外）

各項目の実施状況（本ドキュメント更新時点、実PlanetScale/Supabaseへの実測確認込み）を明記する。

- **[完了（Supabase本番のみ）]** 実Supabase prod/preview DBの Direct connection を使い、
  `export-public-schema.mjs`で実データのpublicスキーマを採取し、
  `db/planetscale/public-schema.sql`を実データベースで再生成する。Supabase**本番**からの
  採取・再生成はChunk 2で実施済み（`db/planetscale/public-schema.sql`は既に実データ由来。
  「Chunk 2 での bootstrap.sql / public-schema.sql 直接更新について」節参照）。Supabase
  **preview**（TwiCa-DEV、`xggxituhkgfxzedtulzb`）からの採取は本セッションでは行っていない
  （次項の比較タスクが未実施である直接の理由）。
- **[未実施]** prod/previewそれぞれのmanifest.jsonを比較し、意図しない差分を一覧化する
  （Issue #691元本文「本番とpreviewを別artifactとして比較」、必須タスク）。前項の通り本セッション
  ではSupabase本番からのみ採取しており、preview側のmanifest.jsonが存在しないため比較そのものを
  実施できていない。Chunk 2の残作業として引き続き追跡する。
- **[完了（prod/preview両方）]** 実PlanetScale prod/preview DBへ`bootstrap.sql`→
  `public-schema.sql`→`grants.sql`を適用し、実機で動作確認する（Docker検証だけでは完了扱いに
  しない、Issue #691元本文の受け入れ条件）。**preview**・**prod**（`bluemoon-works`/`twica`、
  `main`branch、`postgres_database_name`で切替）双方に対して3ファイルを
  `psql -1 -v ON_ERROR_STOP=1`で順に適用し、全てexit 0で完走した。適用後の実オブジェクト数を
  実測し、`db/planetscale/public-schema.sql`正本と完全一致することを両DBで確認した:
  テーブル23／関数27／トリガー9／ポリシー32（`information_schema.tables`/`pg_proc`/
  `pg_trigger`/`pg_policies`で実カウント）。さらに最小限の機能テスト（トランザクション内で
  実行し最後にROLLBACK、データは残していない）として`streamers`テーブルへのINSERT時に
  `extensions.uuid_generate_v4()`のDEFAULTが実際にUUIDを生成すること、
  `extensions.digest('smoke-test','sha256')`（pgcrypto RPC相当）が正常に値を返すことを
  両DBで実機確認した。prodはbootstrap適用前は拡張機能も含め完全に空の状態であり、
  修正済み`bootstrap.sql`（`WITH SCHEMA extensions`）を初回から適用したため、preview側で
  発生した所有者不一致によるDROP/CREATE是正は不要だった（最初から正しいスキーマへ設置）。
- **[一部実施]** **拡張機能の設置スキーマの実測確認・是正（N-5、Fableレビュー2回目 → Chunk 2で
  内容更新）**: 本節はFableレビュー2回目の時点では「`uuid-ossp`は`public`スキーマに設置するのが
  正」という前提（3.3節、当時の`bootstrap.sql`が`WITH SCHEMA public`だった）で書かれていたが、
  Chunk 2で実Supabase本番に接続した結果、`uuid-ossp`/`pgcrypto`とも実際には`extensions`スキーマ
  に設置されていることが判明し、`bootstrap.sql`は`WITH SCHEMA extensions`に修正済みである
  （「Chunk 2 での bootstrap.sql / public-schema.sql 直接更新について」節参照）。したがって
  本節の是正方向も**`extensions`が正・是正コマンドは`SET SCHEMA extensions`**が正しい
  （旧版が記載していた`SET SCHEMA public`は現在の設計と逆方向であり誤りだった。本節はこの
  誤りを修正したものである）。

  実PlanetScale prod/preview（`bluemoon-works`/`twica`データベースの`main`ブランチ、
  `prod`/`preview`論理DB）に接続し、baseline適用前に必ず次のクエリで実測確認すること:
  ```sql
  SELECT extname, extnamespace::regnamespace
  FROM pg_extension
  WHERE extname IN ('uuid-ossp', 'pgcrypto');
  ```
  `uuid-ossp`/`pgcrypto`の`extnamespace`が`extensions`以外だった場合、baseline側の
  `extensions.uuid_generate_v4()`/`extensions.digest()`等の修飾呼び出しが失敗するため、
  baseline適用前に以下で是正する:
  ```sql
  ALTER EXTENSION "uuid-ossp" SET SCHEMA extensions;
  ```
  **注意（実機で遭遇した失敗ケース）**: `ALTER EXTENSION ... SET SCHEMA`は実行ロールが当該
  拡張機能のオブジェクト所有者（owner）でない場合、権限エラーで失敗することがある。実際に
  preview環境で`ALTER EXTENSION "uuid-ossp" SET SCHEMA extensions;`を試みたところ所有者不一致
  で失敗したため、代わりに`DROP EXTENSION "uuid-ossp";` →
  `CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;`（実行ロール自身が新規オブジェクトの
  所有者になる）で是正した。`DROP EXTENSION`は当該拡張機能が提供する関数・型等に依存する
  オブジェクト（baseline適用前の空DBであれば通常存在しない）が無いことを確認してから実行すること。

  **実施状況（本ドキュメント更新時点、実測確認済み）**: previewの`uuid-ossp`/`pgcrypto`は上記の
  手順（DROP→CREATE WITH SCHEMA extensions）で是正済みであることを実測確認した
  （`extnamespace`がいずれも`extensions`）。prodは修正済み`bootstrap.sql`
  （`WITH SCHEMA extensions`）を空の状態から新規適用したため、最初から正しいスキーマへ
  設置され、preview側で発生した所有者不一致によるDROP/CREATE是正は不要だったことを実測確認した
  （`extnamespace`がいずれも`extensions`）。prod/preview両方で本節の是正手順は完了している。
- **[未実施]** `src/lib/db/schema.ts`・実Supabase・PlanetScale baselineの3者比較によるschema
  drift検証（Issue #691元本文タスク5、既知ドリフト#625含む）。Chunk 2のデータ採取時に#625
  ドリフト（battles/battle_stats欠落）の存在は確認できたが、これは実データ採取の副産物として
  気付いたものであり、3者比較を体系的なタスクとして実施したわけではない。
- **[一部実施（コードのみ）]** manifest.json に migration history の最大version（Fableレビュー
  M-7）を追加する: Issue #691本文が要求する項目。当初の本節の記述は対象テーブルを
  `twica_meta.schema_migrations`（`scripts/db-migrate.js`がPlanetScale向けに独自運用する
  履歴テーブル）としていたが、これは誤りだった。実際に必要なのは
  `supabase_migrations.schema_migrations`（Supabase CLI自体が管理するmigration historyテーブル。
  `supabase db push`等が使う）であり、実Supabase本番へ接続して
  `SELECT max(version) FROM supabase_migrations.schema_migrations;`を実測して初めて判明した
  （両テーブルは名前が似ているが別物なので混同注意）。`export-public-schema.mjs`に
  `fetchMaxAppliedMigrationVersion()`（`postgres`パッケージで軽量に1クエリだけ発行、pg_dumpとは
  別接続。テーブルが存在しない/権限が無い環境ではnullを返す）を追加し、`buildManifest()`の
  出力に`maxAppliedMigrationVersion`フィールドとして含めるようにした。単体テストは
  `tests/unit/db-phase2/export-public-schema.test.ts`に`buildManifest`のfixtureベースで追加
  （`fetchMaxAppliedMigrationVersion`自体はDB接続を要するCLI統合部分のため、main()と同様に
  単体テスト対象外とし、実機検証で確認する方針を踏襲）。

  **未達成の実態（訂正、必読、M-2）**: 上記はコードの実装状況の記述であり、「実データで
  `maxAppliedMigrationVersion`が実際に取得できた」ことを意味しない。Chunk 2で実Supabase本番へ
  `export-public-schema.mjs`を実行した際に使用した接続ロールは`twica_app`（アプリ実行用の
  制限付きロール）であり、`supabase_migrations`スキーマへの権限（`USAGE`/`SELECT`）を
  持っていなかった。そのため実行結果は`fetchMaxAppliedMigrationVersion()`が権限エラーを
  捕捉して`null`を返すフォールバック動作のみが確認された状態であり、実際の
  `maxAppliedMigrationVersion`の値は**一度も取得できていない**。「コードが安全にフォールバック
  する設計になっている」ことと「実データで値が取得できている」ことは別であり、後者は未達成の
  まま残っている。

  **今後の選択肢（オーナー判断が必要、本セッションではどちらも未実施）**: Issue #691本文は
  「Supabaseの管理者/direct connectionを使用してschema-only dumpを取得する」と明記しており、
  本来は管理者ロールでの取得が想定されている可能性が高い。ただし今回のセッションでは
  オーナーがSupabaseの`postgres`ロール（管理者ロール）のパスワードを紛失しており
  （シークレットに保存されているのみで本人も把握していない）、これを取得するには本番の
  `postgres`パスワードをリセットする必要がある。パスワードリセットは他の接続経路にも影響し
  得る大きな判断を要する操作のため、今回は意図的に避け、`twica_app`のみを使う方針とした。
  今後この項目を完了させるには、以下いずれかをオーナーが選択して実施する必要がある:
  1. `twica_app`ロールに`supabase_migrations`スキーマへの読み取り専用GRANTを追加する
     （必要最小限の権限に絞る場合の例:
     `GRANT USAGE ON SCHEMA supabase_migrations TO twica_app;`
     `GRANT SELECT ON supabase_migrations.schema_migrations TO twica_app;`）。
  2. Supabase `postgres`ロールのパスワードをリセットし、管理者接続を別途用意する。

  いずれも本ドキュメント更新時点では**未実施**である。
- **[未実施]** **grants.sqlの`ALTER DEFAULT PRIVILEGES`にFOR ROLEを明示する（Fableレビュー M-3の
  後続）**: `db/planetscale/grants.sql`のコメントに記載の通り、Chunk 1時点では実PlanetScaleで
  migrationを適用する管理ロール名が未確定のため`FOR ROLE`句を意図的に省略している。Chunk 2で
  PlanetScale接続・実際の管理ロール運用が確定した時点で、`FOR ROLE <確定ロール名>`を明示すること
  （`twica_app`はCREATEROLE権限を持たずbootstrap.sql自体を適用できないロールのため対象外。
  詳細はgrants.sql内コメント参照）。本ドキュメント更新時点で実PlanetScaleへの読み取り接続は
  行ったが、migration適用の管理ロール運用自体はまだ確定していないため、本項目は引き続き未実施。
- **[手順定義のみ・本チャンクでは未使用]** **baseline再生成時のchecksum衝突運用手順（Fableレビュー M-8 → N-1で更新）**: `db-migrate.js`の
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

  **本チャンクでの利用状況**: Chunk 2で発生した2件の修正（uuid-osspスキーマ誤り・
  public-schema.sqlの実データ置き換え）は、上記1〜5の手順（新バージョンファイルを追加する
  通常運用）ではなく、後述「Chunk 2 での bootstrap.sql / public-schema.sql 直接更新について」
  節に記載の**例外的な直接書き換え**で対応した（`--bootstrap`登録がまだ一度も行われていない
  ことを実測確認できたため）。したがって本節の手順1〜5自体は、本チャンクではまだ一度も
  使われていない。将来2回目以降の差分追加（実PlanetScale環境への登録後の再修正）が必要に
  なった時点で、初めて本来の手順として使用される想定である。

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

### Chunk 2 での bootstrap.sql / public-schema.sql 直接更新について（凍結ルールの例外運用）

Chunk 2（実Supabase本番への接続、本節）の作業中に2つの問題が見つかり、いずれも
`db/planetscale/bootstrap.sql` と `db/planetscale/public-schema.sql`（正本2ファイル）を
修正した:

1. **`uuid-ossp` の設置スキーマの誤り**: Chunk 1時点のローカルDocker検証は
   Supabase固有の「`uuid-ossp`/`pgcrypto`を`extensions`スキーマへ設置する」という
   運用規約を再現していなかった。そのため`bootstrap.sql`は当初`uuid-ossp`を
   `WITH SCHEMA public`としていたが、実Supabase本番へ接続し
   `SELECT extname, extnamespace::regnamespace FROM pg_extension WHERE extname IN
   ('uuid-ossp','pgcrypto')`を実行したところ、両方とも`extensions`スキーマに
   インストールされていることを実測確認した。`WITH SCHEMA extensions`に修正した
   （`CREATE SCHEMA IF NOT EXISTS extensions;`をpgcryptoセクションからuuid-osspセクションの
   前に移動）。
2. **`public-schema.sql`がDocker検証用の暫定データのままだった**: 本チャンクの目的どおり、
   実Supabase本番から`export-public-schema.mjs`→`normalize-schema.mjs`で採取した実データ
   （テーブル23・関数27・トリガー9等、既知の#625ドリフト＝battles/battle_stats欠落を含む）に
   置き換えた。

この2件の修正を、通常の運用ルール（本節冒頭「baseline再生成時のchecksum衝突運用手順」の
手順1〜5、正本は自由に再生成してよいが`db/planetscale/migrations/`配下の凍結済みコピーは
新しいタイムスタンプの別ファイルとして追加し、既存ファイルは書き換えない）ではなく、
`db/planetscale/migrations/20260719180000_planetscale_bootstrap.sql` /
`20260719180100_planetscale_public_schema_baseline.sql` を**直接書き換える**形で反映した。
これは凍結ルールの原則からの逸脱に見えるため、なぜここに限り安全と判断したかを明記する:

- 凍結ルール（本節・`tests/unit/db-phase2/migration-sync.test.ts`冒頭コメント）が守ろうと
  しているのは「`db-migrate.js apply --bootstrap`で実PlanetScale環境（prod/preview）の
  `twica_meta.schema_migrations`にchecksumとして登録済みのmigrationファイルを書き換えると、
  以後のapply/verifyがchecksum不一致で即エラー終了する」という実害である。
- Chunk 2でこの2件を修正した時点で、`db/planetscale/migrations/`配下のこの2ファイルは
  実PlanetScale環境に対して`--bootstrap`で**一度も登録されていなかった**（このセッションで
  実施したのはpsqlによるローカルDocker上の空DBへの直接apply検証のみ。実PlanetScale
  prod/previewへの適用はFableレビュー後に別途実施する方針で、本タスクのスコープ外）。
  つまり「登録済みchecksumとの不一致」が発生する余地が無く、凍結ルールが保護しようとしている
  実害そのものが存在しない状態だった。
- そのため今回に限り、新しいバージョンのmigrationファイルを追加するのではなく、
  該当2ファイルを直接書き換え、`tests/unit/db-phase2/migration-sync.test.ts`の
  `FROZEN_BODY_SHA256`エントリも新しい内容のsha256ハッシュへ更新した。

**検証方法（N-1、Fableレビュー指摘を受けて追記）**: 上記の「一度も登録されていなかった」という
前提は推測ではなく、実PlanetScale prod/preview双方（`bluemoon-works`/`twica`データベース、
`main`ブランチの`prod`/`preview`論理DB、`postgres_database_name`で切替）に対して以下のクエリを
実行し、`twica_meta`スキーマ自体が存在しないことを確認して裏付けた（2026-07-20実施）:

```sql
SELECT to_regclass('twica_meta.schema_migrations') AS twica_meta_schema_migrations,
       to_regnamespace('twica_meta') AS twica_meta_schema;
```

結果（prod/preview共通）:

| 論理DB | twica_meta_schema_migrations | twica_meta_schema |
|---|---|---|
| prod | NULL | NULL |
| preview | NULL | NULL |

両方ともNULL（`twica_meta`スキーマ自体が存在しない）であり、`--bootstrap`によるchecksum登録が
一度も行われていないことを実測で確認した。

**順序リスクの注記**: 本ドキュメント・`db/planetscale/migrations/`配下2ファイル・
`tests/unit/db-phase2/migration-sync.test.ts`の`FROZEN_BODY_SHA256`は、いずれも今回のChunk 2
変更（実データへの更新）を前提にセットで更新されている。もしこの変更が取り込まれる**前**に
何らかの理由で`db-migrate.js apply --bootstrap --provider=planetscale`が実PlanetScale環境に
対して実行されてしまうと（＝旧内容のchecksumが先に登録されてしまうと）、その後この変更を
取り込んだ時点で`db/planetscale/migrations/`側のファイル内容（＝checksum）が変わっているため、
以後の`apply`/`verify`がchecksum不一致で即エラー終了する。したがって**本変更のマージ・適用は
`--bootstrap`の実行より必ず先に行うこと**（逆順で進めないよう運用上の注意点として明記する）。

**重要（将来同じ状況を混同しないための注意）**: この判断が成り立つのは
「`--bootstrap`登録がまだ一度も行われていない」という前提が成立している間だけである。
将来、実PlanetScale環境へ`--bootstrap`で登録した**後**に同種の修正が必要になった場合は、
この直接書き換えパターンを踏襲せず、必ず本来の凍結ルール（新しいタイムスタンプの
migrationファイルを追加し、既存の`20260719180000`/`20260719180100`エントリおよび
テストの`FROZEN_BODY_SHA256`は変更しない）に従うこと。
