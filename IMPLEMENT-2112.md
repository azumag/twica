# Issue #2112 整合 migration 実装記録

## 概要

未所持カードの項目別公開設定（名前・画像・説明の新3列）と、旧 `show_unowned_card_details` が食い違う行を整合させる migration を追加した。本タスクでは migration とテスト、運用判断の記録だけを行い、本番データベースへの書き込み、本番デプロイ、本番環境への接続は一切行っていない。

追加した migration:

- `db/planetscale/migrations/20261126120000_reconcile_unowned_card_visibility_items.sql`

## 調査結果

### migration の置き場所・命名・実行方法

- #2110 の列追加 migration は `db/planetscale/migrations/20261122120000_add_unowned_card_visibility_items.sql` に置かれている。今回も同じ配置を使う。
- ファイル名は `YYYYMMDDHHMMSS_説明.sql` 形式で、runner はファイル名順に適用する。
- 先頭の `-- migration-transaction: required` は SQL 全体を1トランザクションで実行する宣言、`-- migration-providers: planetscale` は PlanetScale 用 migration である宣言である。
- `scripts/db-migrate.js` は `supabase/migrations/` と `db/planetscale/migrations/` の両方を読み、provider 宣言で対象を絞って適用する。CI の `planetscale-migration-postgres` ジョブも同じ descriptor 解析で PostgreSQL 17 へ順次適用する。
- 今回の補正は `#2111` のアプリが本番で先に動いている必要があるため、`-- app-first: #2111` ヘッダーを付けた。`docs/QA.md` の昇格手順では、このヘッダー付き migration は依存するアプリ変更の本番稼働確認が済むまで昇格を止める。

### #2110/#2111 の既存実装

- #2110 は新3列 `show_unowned_card_name` / `show_unowned_card_image` / `show_unowned_card_description` を追加し、旧設定で詳細公開だった行を一度だけバックフィルした。
- #2111 の設定 API は、新3項目のどれかを保存するとき、旧 `show_unowned_card_details` に「新3列すべて true のときだけ true」という AND を同一 `UPDATE` 内でミラー書込みする。
- 旧クライアントが旧 `showUnownedCardDetails` だけを送った場合は、新3項目と旧列へ同じ値を展開するため、#2111 以降の新しい書き込み経路では4列が矛盾しない。
- 一方、#2111 より前の旧アプリは新3列を知らず旧列だけを書き換えるため、移行期間の書き込みでは食い違いが残り得る。

### resolver の規則 c と設定画面

- `src/lib/unowned-card-visibility.ts` の `resolveUnownedCardVisibility` は、規則 c として「`show_unowned_card_details = false` かつ新3列がすべて true」の行を全項目非公開に倒す。部分公開は新アプリの正当な状態なので、このガードは全項目 true のときだけ発動する。
- 設定画面の初期値は `src/lib/dashboard-data.ts` の `getStreamerCollectionSettings` が作り、`src/app/dashboard/account/page.tsx` から `src/components/CardVisibilitySettings.tsx` へ渡している。
- 現在の `getStreamerCollectionSettings` は、デプロイ窓で新3列が取れない場合だけ resolver の規則 b と同じ fallback を行う。新3列が取得できた通常経路では、規則 c を適用せず生の3列を返す。

## 実装内容

migration は2本の `UPDATE` だけを行う。schema 変更、削除、旧列の更新、マスタースイッチ `show_unowned_cards` の更新は行わない。

### (a) 旧アプリで詳細公開を OFF にした行

対象:

- `show_unowned_card_details = false`
- 新3列がすべて `true`

補正:

- 新3列をすべて `false` にする。

理由:

- この組み合わせは #2111 以降の新しい書き込み経路では作れない。新アプリは3列すべて true なら旧列へ true をミラーするためである。
- resolver の規則 c はこの行を非公開として扱うが、生の新3列は true のまま残る。残存した true を放置すると、後の部分保存でミラー式が他列の true を拾い、旧列を true に戻して公開を復活させうる。

### (b) 旧列 true と新3列が食い違う行

対象:

- `show_unowned_card_details = true`
- 新3列がすべて `true` ではない

補正:

- 新3列をすべて `true` にする。

理由:

- 旧列 true は旧アプリでは「名前・画像・説明をまとめて公開する」意味だった。
- 部分公開や全非公開に見える新3列を残すと、旧アプリと新アプリで公開範囲が食い違う。

### 対象外

次の行は変更しない。

- `details = false` で新3列の一部だけ true の行。これは新アプリの部分公開を保存した正当な状態で、旧列 false はミラー結果として正しい。
- `details = false` かつ新3列がすべて false の行。
- `details = true` かつ新3列がすべて true の行。

`show_unowned_cards` は条件に入れない。マスタースイッチが false の行でも、新旧4列の関係は同じ規則で保存されるべきであり、後でマスターを ON にしたときの公開範囲を配信者の設定どおりに保つためである。

### 冪等性

- (a) の補正後は「新3列がすべて true」という対象条件を満たさない。
- (b) の補正後は「新3列がすべて true ではない」という対象条件を満たさない。
- したがって同じ migration を再実行しても 0 行更新になり、整合済みの行を上書きしない。

### 業界標準との対応

この変更は、expand-and-contract における「新しい書き込み経路の dual-write を先に稼働させた後、既存データを reconcile する migrate 段階」に相当する。#2110/#2111 で新3列の追加と dual-write 相当のミラー書込みを済ませ、今回の migration で既存の矛盾だけを冪等に補正する。旧列の削除（contract）は今回の範囲外である。対象行は現時点で 0 件の見込みであり、対象は食い違い行だけに限定されるため、大規模バックフィル向けの分割処理は入れず、1トランザクションの条件付き `UPDATE` に留めた。

## テスト

追加したテスト:

- `tests/unit/unowned-card-visibility-reconciliation-migration.test.ts`
  - migration の順序、header、(a)(b) の対象条件、冪等性を支えるガード、旧列とマスタースイッチを更新しないこと、schema 変更や削除を含まないことを固定する。
- `tests/integration/unowned-card-visibility-reconciliation-migration-pg.test.ts`
  - 実 PostgreSQL で migration ファイル自体を再実行し、(a) が全 false、(b) が全 true、正当な部分公開と整合済み行が不変、再実行で全行が不変であることを確認する。
  - 環境変数 `UNOWNED_RECONCILIATION_TEST_DATABASE_URL` が無い環境ではスキップされる。CI では全 migration 適用済みの PostgreSQL 17 に対して実行するよう `.github/workflows/ci.yml` に step を追加した。

ローカルでのテスト実行結果は、このファイルの末尾「検証記録」を参照する。

## 設定画面の初期値を resolver の解決後の値にするかの検討

判断: 今回は実装しない。

根拠:

1. resolver が返すのは「閲覧者へ実際に公開されるか」という実効値であり、設定画面が編集する「保存された項目別設定」と同じ意味ではない。特に規則 a はマスタースイッチが OFF のとき全項目 false を返すため、そのまま初期値にすると、保存済みの項目別設定とマスタースイッチの状態を同一のチェック状態へ混線させる。
2. 食い違い (a) に対して表示だけを resolver の値へ変えても、DB の生の新3列は true のまま残る。その状態で1項目だけ保存すると、ミラー式はリクエストに無い項目を現在列から拾うため、旧列を true に戻す根本的な経路は残る。表示だけを変える対応は、かえって「画面では false に見えるのに保存結果は全公開になる」食い違いを大きくし得る。
3. この問題の正しい修正は、食い違い自体を消す migration である。migration 適用後は、新アプリが作る正当な状態では `details = (name AND image AND description)` が成立し、規則 c の対象行は残らない。したがって通常経路では生の3列と resolver の結果は一致する。
4. デプロイ窓で新3列が取れない場合の fallback は、すでに `getStreamerCollectionSettings` が resolver の規則 b と同じ all-or-nothing で行っている。

なお、万が一 migration 適用前の食い違い行を設定画面で編集する場合まで防衛するには、初期値だけでなく保存時の送信範囲やミラー計算まで設計を変える必要がある。部分更新の並行性を損なわない設計が必要なため、今回のデータ整合 migration に混ぜず、必要なら別 Issue で検討すべきと判断した。

## 本番件数確認用の読み取りクエリ

適用直前に、本番で次の `SELECT` だけを実行して件数を確認する。期待値は3つの count すべて 0 件である。

```sql
SELECT
  count(*) FILTER (
    WHERE show_unowned_card_details = false
      AND show_unowned_card_name = true
      AND show_unowned_card_image = true
      AND show_unowned_card_description = true
  ) AS case_a_legacy_off_rows,
  count(*) FILTER (
    WHERE show_unowned_card_details = true
      AND NOT (
        show_unowned_card_name = true
        AND show_unowned_card_image = true
        AND show_unowned_card_description = true
      )
  ) AS case_b_inconsistent_rows,
  count(*) FILTER (
    WHERE (
      show_unowned_card_details = false
      AND show_unowned_card_name = true
      AND show_unowned_card_image = true
      AND show_unowned_card_description = true
    )
    OR (
      show_unowned_card_details = true
      AND NOT (
        show_unowned_card_name = true
        AND show_unowned_card_image = true
        AND show_unowned_card_description = true
      )
    )
  ) AS rows_to_reconcile
FROM public.streamers;
```

このクエリは読み取り専用であり、行の更新・削除・schema 変更を行わない。本タスクでは本番へアクセスできないため実行していない。

## 本番適用の前提条件

- #2111（新3列の保存と旧列への AND ミラー書込みを行うアプリ）が本番で実行済みであることが前提である。
- この確認は本番環境へのアクセスを必要とするため、本タスクでは実施できない。ゲート（メイン Muse）と owner が、migration を適用する前に確認すること。
- migration には `app-first: #2111` ヘッダーを付けたため、昇格手順でも同じ前提が機械的に検出できる。
- 旧アプリが残ったまま適用すると、migration 自体が失敗するわけではないが、その後の旧列だけを書き換える操作で同じ食い違いを再発させ得る。

## 検証記録

- `git diff --check`: 実施済み。空白エラーなし。
- unit test `npx vitest run tests/unit/unowned-card-visibility-reconciliation-migration.test.ts`: 未実行。この環境には `node_modules` が無く、コマンド実行も拒否された。依存関係を新たに install すると作業範囲外の環境変更になるため、install は行わなかった。
- typecheck `npm run typecheck`: 未実行。理由は unit test と同じである。
- integration test: 未実行。`node_modules` が無く vitest を実行できず、専用 PostgreSQL の利用可否も確認できなかった。CI では全 migration 適用済みの PostgreSQL 17 に対して実行されるよう workflow を追加済みである。
- 上記の実行可否とは別に、migration・テスト・workflow 差分を通読し、対象条件と冪等性の静的整合を確認した。ただしこれはコンパイラ・実 PostgreSQL 検証の代替ではない。
