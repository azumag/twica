# DB Phase 2 メンテナンスランブック（Supabase → PlanetScale Postgres 切替）

Issue #666（親: #664 / #568 Phase 2-2）のドラフト。

**ステータス: ドラフト・未承認。実施日時・告知文面・read-only 実装方式のいずれもオーナー確認前。本ドキュメントの「切替」「実施」はすべて計画段階の記述であり、実施許可を意味しない。**

## 0. 前提・スコープ

- Phase 1（#570〜#573、PR #630・#636 でマージ済み）でデータアクセス層は
  Hyperdrive + postgres.js + Drizzle 直結に対応済み（`DB_DRIVER` /
  `GACHA_DB_DRIVER` フラグ、詳細は `docs/db-driver-migration.md`）。
  **DB 本体は現時点でも Supabase のまま。** Phase 2 はその接続先を
  PlanetScale Postgres（東京リージョン）へ切り替える工程であり、
  アプリケーションコードの変更は原則不要（Hyperdrive の接続文字列を
  差し替えるだけで pg 直結経路がそのまま新 DB を向く設計）。
- 本番切替は #664 に定義された前提どおり、**子 issue（#665 migration 移植監査 /
  #666 本ランブック / #667 logical replication 可否検証）が全て完了し、
  オーナーの明示的な GO 判断が出るまで着手しない。**
- 基本方式は「数分の書き込み停止ウィンドウ」（#568 決定事項）。#667 で
  logical replication によるほぼ無停止化が可能と判定された場合は、
  本ランブックの 5章（切替手順）を無停止方式に更新する。それまでは
  以下の pg_dump/restore 方式を正とする。
- `docs/planetscale-migration-audit.md` は本ドキュメント作成時点
  （2026-07-10）で**存在を確認できなかった**（#665 は未着手と思われる）。
  同ファイルが作成され次第、特に 6章（シーケンス値）を実測値で見直すこと。

## 1. 現状把握（DB 規模・スキーマ規模）

実測ではなく、リポジトリ内の情報から確認・推定した値。

| 項目 | 値 | 根拠 |
|---|---|---|
| DB サイズ | 0.334GB（2026-07-07 時点） | Issue #664 本文の記載（Supabase ダッシュボード参考値。実測の再取得は #664 の未確認事項として残っている） |
| migration ファイル数 | 65 ファイル（`00001`〜`00073`、欠番あり） | `ls supabase/migrations/*.sql \| wc -l` で実カウント（2026-07-10） |
| テーブル数 | 25 | migrations 内の `CREATE TABLE` を抽出した数と `src/lib/db/schema.ts` の `pgTable(` 呼び出し数が一致（25）することを確認済み |
| plpgsql 関数 | 約28（`CREATE [OR REPLACE] FUNCTION` の重複除去後の一意名） | grep による概算。#568 本文の「20+」と符合 |
| トリガー | 11 | `CREATE TRIGGER` の一意名カウント。#568 本文の記載と一致 |
| SERIAL/IDENTITY 列・DB シーケンス | **ゼロ** | `serial\|generated.*identity\|create sequence\|nextval` で全 migration を grep したが該当なし。主キーは全テーブル UUID（`gen_random_uuid()` 等、11ファイルで使用確認） |

0.334GB は PS-5（$5/月、単一ノード）の込み容量に十分収まる規模であり、
pg_dump/restore のデータ転送自体は短時間で完了すると見込まれる
（詳細は 5章）。ただし PS-5 の具体的なストレージ上限・課金体系は
#568/#664 の未確認事項として残っており、着手前に確認が必要。

## 2. 全体スケジュール（案）

実施日時は未定のため、相対日付で記載する。

| タイミング | 内容 |
|---|---|
| D-7 | 配信者向け事前告知（3章テンプレート） |
| D-1 | リマインド告知 |
| D-day, 直前 | `MAINTENANCE_READ_ONLY=true` 投入（preview → prod の順） |
| D-day, 切替作業 | 5章の手順（pg_dump → restore → 検証 → Hyperdrive 向き先変更） |
| D-day, 直後 | read-only 解除、EventSub リプレイ、6章チェックリスト |
| D-day 〜 D+1 | `wrangler tail` による監視継続（最低30分、異常時は延長） |
| D+1 | 完了報告・告知 |

## 3. 告知文面テンプレート（配信者向け・ドラフト）

具体的な日時は `<YYYY-MM-DD HH:MM JST>` のプレースホルダとする。
**文面の最終確認・トーン調整はオーナー承認が必要（7章参照）。**

### 3.1 事前告知（D-7 目安）

```
【メンテナンスのお知らせ】

いつも twica をご利用いただきありがとうございます。
データベース基盤の切替作業のため、下記の日時に短時間のメンテナンスを実施いたします。

■ 日時: <YYYY-MM-DD HH:MM JST> 〜 <YYYY-MM-DD HH:MM JST>（予定・最大 <N> 分程度）
■ 想定される影響:
  - メンテナンス時間中は、ガチャの実行・カード付与・支援コードの登録など
    「データを書き込む操作」が一時的にご利用いただけません
    （エラー画面ではなく、メンテナンス中である旨のメッセージが表示されます）
  - カード一覧の閲覧などの「閲覧のみの操作」は通常どおりご利用いただけます
  - メンテナンス時間中にチャンネルポイントでガチャを引かれた場合も、
    ポイントは正しく消費され、メンテナンス終了後に自動でカードが付与されます
    （二重付与・ポイントの二重消費は発生しません）
  - overlay（配信画面演出）は再接続が必要になる場合があります
■ 作業内容: データベース基盤の切替（ユーザー影響のある機能変更ではありません）

ご不便をおかけしますが、何卒よろしくお願いいたします。
```

### 3.2 リマインド告知（D-1 目安）

```
【明日メンテナンスを実施します】

明日 <YYYY-MM-DD HH:MM JST> から最大 <N> 分程度、データベース基盤切替の
メンテナンスを実施します。メンテナンス中はガチャ等の書き込み操作が一時停止します
（詳細は先日の告知をご確認ください）。ご協力をお願いいたします。
```

### 3.3 開始時（当日）

```
【メンテナンスを開始しました】
現在メンテナンス中です（開始: <HH:MM JST>）。終了次第あらためてお知らせします。
```

### 3.4 完了報告（D-day 直後 or D+1）

```
【メンテナンスが完了しました】
<HH:MM JST> にメンテナンスが完了し、全機能が通常どおりご利用いただけます。
メンテナンス時間中に実行されたガチャは全て正常にカード付与済みです。
ご協力ありがとうございました。
```

## 4. read-only フラグの実装方式（提案）

`docs/db-driver-migration.md` の `DB_DRIVER`/`GACHA_DB_DRIVER` と同じ
「env を毎回読む・trim する・不正値は安全側に倒す」パターンに倣う。

### 4.1 フラグ本体

`src/lib/db/flags.ts` に既存の `getDbDriverMode` 等と並べて追加する:

```ts
/**
 * メンテナンス read-only モード判定 (#666, #568 Phase 2)。
 *
 * true の間、書き込み系 API ルートは実処理の前に 503 を返す
 * （maintenanceReadOnlyResponse() 参照）。DB_DRIVER 系フラグと同様、
 * process.env は呼び出しのたびに読む（モジュールトップでキャッシュしない）。
 * trim するのは Cloudflare 側の secret 設定に改行・空白が混入しうるため
 * （DB_DRIVER 等と同じ既知リスク）。
 */
export function isMaintenanceReadOnly(): boolean {
  return process.env.MAINTENANCE_READ_ONLY?.trim() === 'true'
}
```

### 4.2 書き込みルート用ヘルパー

新規ファイル `src/lib/api/maintenance-guard.ts`（DB ドライバの選択とは
別関心事のため `db/flags.ts` からは分離する）:

```ts
import { NextResponse } from 'next/server'
import { isMaintenanceReadOnly } from '@/lib/db/flags'

/**
 * 書き込み系 API ルートの先頭で呼ぶ。read-only 中は 503 を返す
 * NextResponse を、そうでなければ null を返す。
 * Retry-After はメンテナンス想定所要時間の目安（運用者が調整）。
 */
export function maintenanceReadOnlyResponse(): NextResponse | null {
  if (!isMaintenanceReadOnly()) return null
  return NextResponse.json(
    {
      error: 'maintenance',
      message:
        'ただいまメンテナンス中のため、書き込み操作を一時的に停止しています。しばらくしてから再度お試しください。',
    },
    { status: 503, headers: { 'Retry-After': '600' } }
  )
}
```

使用例（各書き込みルートの先頭、既存の rate limit チェック等と同じ並びで）:

```ts
export async function POST(request: NextRequest) {
  const maintenanceResponse = maintenanceReadOnlyResponse()
  if (maintenanceResponse) return maintenanceResponse
  // ...既存処理
}
```

### 4.3 EventSub webhook は明示的に対象外とする

`src/app/api/twitch/eventsub/route.ts` は **このガードを呼ばない**。
#568 で確定済みのとおり、メンテナンス中も Twitch へは 2xx を返し、
payload を KV に退避して切替後にリプレイする（`event_id` 冪等チェックが
既にあるため二重付与は起きない）。そのため EventSub ルートは
read-only 中は「DB に書かず KV に退避する」専用の分岐を通す設計とし、
503 では応答しない（Twitch 側のリトライ・subscription revoke を避けるため）。
この KV 退避＋リプレイの実装自体は本ランブックのスコープ外
（#666 の作業項目としては「挙動の確認」のみで、実装は別途必要 — 7章参照）。

### 4.4 「全書き込みルートに漏れなく適用されているか」の担保（未決定）

書き込みルートごとに個別 import するオプトイン方式は、実装漏れのリスクがある。
候補として以下のいずれか（または組み合わせ）を検討する:

- **案A（本ランブックの主案）**: 各書き込みルートで明示的に呼ぶ。
  既存の `DB_DRIVER` 系フラグと同じ「明示チェック」の流儀に揃えられ、
  EventSub のような例外ルートも自然に除外できる。漏れは目視レビュー頼み。
- **案B**: `middleware.ts`（`src/middleware.ts`）で `POST`/`PUT`/`PATCH`/`DELETE`
  かつ `/api/*` のリクエストを一律ブロックし、EventSub 等の例外だけ
  allowlist で通す。漏れにくいが、`middleware.ts` は現状ロケール検出・
  レート制限用でルート単位のセマンティクス（どれが「書き込み」か）を
  持っておらず、実装が複雑化する。
- **案C**: `scripts/check-migration-order.js` に類する CI スクリプトを新設し、
  `src/app/api/**/route.ts` の `export async function POST/PUT/PATCH/DELETE`
  を機械的に検出して `maintenanceReadOnlyResponse` の import 有無を
  チェックする（EventSub 等は allowlist）。

**この4.4節の採否・どの案を採るかはオーナー確認が必要（7章）。**
本ランブックは実装方式の提案までであり、実装自体は別 PR で行う。

## 5. pg_dump/restore の実行手順とダウンタイム見積り

リポジトリ内に pg_dump/pg_restore 関連の既存スクリプトは**見つからなかった**
（`scripts/` 配下を確認。`scripts/verify-db-schema.js` は切替前後のスキーマ照合
専用で、ダンプ/リストア自体は行わない）。以下はコマンドラインでの手順案。
再現性のため、実施が近づいた段階で `scripts/` にラップスクリプト化することを推奨する。

### 5.1 手順

1. **read-only 化**: preview → prod の順で `MAINTENANCE_READ_ONLY=true` を投入
   （4章）。書き込み系エンドポイントが 503 を返すことを1件確認する。
2. **インフライト接続のドレイン待ち**: 数十秒程度のバッファを置く。
3. **pg_dump（Supabase Direct connection から）**:
   ```bash
   pg_dump "postgresql://twica_app:<password>@<supabase-direct-host>:5432/postgres?sslmode=require" \
     -Fc --no-owner --no-privileges \
     -f twica_prod_$(date +%Y%m%dT%H%M%S).dump
   ```
   - `-Fc`（custom format）: 圧縮され、並列 restore・テーブル単位の
     selective restore が可能。
   - `--no-owner --no-privileges`: PlanetScale 側のロール名は
     `twica_app` と同一に揃えられるとは限らないため、所有者/権限の
     ダンプ復元は行わず、restore 後に `docs/db-driver-migration.md`
     セットアップ手順（`grant service_role` 相当・`BYPASSRLS`）を
     PlanetScale 側のロール構成に合わせて別途適用する
     （PlanetScale の RLS/ロール機構が Supabase と同一とは限らない点は
     #665 監査で要確認）。
   - 接続文字列は `docs/db-driver-migration.md` の Direct connection
     手順で取得したもの（`sslmode` を必ず維持）。
4. **ダンプ内容の事前確認**: `pg_restore -l twica_prod_*.dump` で
   テーブル数（25）・関数（約28）・トリガー（11）が想定件数と
   大きく乖離していないことを目視確認する。
5. **PlanetScale Postgres への restore**:
   ```bash
   pg_restore --no-owner --no-privileges --clean --if-exists \
     -d "postgresql://<planetscale-role>:<password>@<planetscale-host>:5432/<db>?sslmode=require" \
     twica_prod_*.dump
   ```
   - `--clean --if-exists`: preview リハーサルでの再実行を安全にするため。
     本番の初回カットオーバーでは対象 DB が空である前提のため実質 no-op。
6. **スキーマ照合**: `DATABASE_URL=<PlanetScale接続文字列> node scripts/verify-db-schema.js`
   を実行し、`src/lib/db/schema.ts` との差分ゼロ・SELECT smoke 成功を確認する
   （既存スクリプトをそのまま流用可能。CI では実行しない運用も踏襲）。
7. **シーケンス値の確認**（6章）。
8. **Hyperdrive の接続先を PlanetScale に切り替える**（`wrangler hyperdrive
   update` または config 再作成。詳細は 7章ロールバック手順と対になる操作）。
9. **最小限の書き込み系疎通確認**を1系統実施（例: ガチャ実引き1回）。
10. **read-only 解除**（prod → preview の順、または一括）。
11. **EventSub リプレイ**: メンテナンス中に KV へ退避された payload を
    リプレイする（4.3節、実装は別スコープ）。
12. 6章の検証チェックリストを実施。異常があれば7章のロールバック手順に切替。

### 5.2 ダウンタイム見積り

DB サイズ 0.334GB（1章）・テーブル25・インデックス/制約付きの小規模 OLTP
スキーマという前提での**概算**（実測ではない）。

| 区間 | 見積り | 根拠 |
|---|---|---|
| pg_dump | 数十秒〜1分程度 | 0.334GB は custom format 圧縮ダンプとして小規模。ネットワーク帯域より DB 側のスキャン/圧縮がボトルネックになりにくい規模 |
| pg_restore（インデックス再構築含む） | 1〜3分程度 | テーブル数25・インデックス数十本程度の規模であれば、単一ノード PS-5 でも数分以内が妥当な見積り |
| スキーマ照合 + 最小疎通確認 | 数分 | `verify-db-schema.js` 実行 + 手動でのガチャ実引き確認 |
| **書き込み停止が必須な区間の合計目安** | **5〜10分程度** | 上記の合計。#568 の「数分の書き込み停止ウィンドウ」方針と整合 |
| 告知上の想定所要時間（バッファ込み） | 最大15〜30分程度 | 異常時の判断・ロールバック検討の時間を見込んだ告知用の幅。3章テンプレートの `<N>` に反映する |

**重要**: `docs/db-driver-migration.md` にある「切替後 `wrangler tail` を
最低30分監視」という Phase 1 の運用は、Phase 2 でも踏襲するが、
これは書き込み停止の延長ではない。5〜10分の停止区間で最小限の疎通確認が
通り次第 read-only を解除して書き込みを再開し、その後の詳細監視・
6章の残りのチェック項目は書き込み再開後も並行して継続してよい
（異常が見つかった場合のみ、その時点で7章のロールバック判断を行う）。

実測に基づく再見積りは、preview 環境でのリハーサル実施後に本節を
更新すること（#666 の受け入れ条件「preview でのリハーサルで手順どおりに
完了できることを確認」に対応）。

## 6. 検証チェックリスト

`docs/db-driver-migration.md` の Phase 1 preview 検証項目をベースに、
Phase 2（プロバイダ切替）特有の項目を追加したもの。

### 6.1 データ整合性（切替直後・書き込み停止区間内）

- [ ] `pg_dump`/`pg_restore` がエラーなく完了（`pg_restore` の終了コード・
      WARNING ログを確認）
- [ ] `scripts/verify-db-schema.js` が PlanetScale の `DATABASE_URL` に対して
      差分ゼロ・全25テーブルへの SELECT smoke 成功
- [ ] 25テーブル全ての行数が dump 時点の Supabase 側件数と一致
      （read-only 化後に dump しているため一致するはず。不一致は
      read-only が効いていなかった可能性を示す重大な兆候）
- [ ] 11個のトリガー・約28個の plpgsql 関数が復元されている
      （`pg_restore -l` の内容と一致するか、または `\df`/`\dg` 相当の
      information_schema クエリで確認）
- [ ] `uuid-ossp` 拡張が有効（`gen_random_uuid()` 系の呼び出しが失敗しないこと）
- [ ] PlanetScale 側の接続ロールに `docs/db-driver-migration.md` 相当の
      権限構成（`service_role` 相当の GRANT・JWT クレーム述語 RLS を持つ
      5テーブルへの `BYPASSRLS` 相当）が適用されている
      （PlanetScale の RLS/ロール機構が Supabase と同一のセマンティクスとは
      限らないため、#665 監査結果を踏まえて手順を読み替えること）
- [ ] シーケンス現在値が正しい（6章 → 本節の下、独立の6.4節参照）

### 6.2 PostgREST 依存が完全に無いこと（Phase 2 新規追加項目）

**注意（スコープの切り分け）**: ここでいう「PostgREST 依存」は
supabase-js 経由の **DB クエリ**（`.from()`/`.rpc()`）を指す。
Supabase **Realtime**（ガチャ結果 overlay の broadcast 通知、
`postgres_changes` は不使用）は Phase 3（Durable Objects 移行）まで
Supabase プロジェクト自体を稼働させたまま利用し続ける設計であり
（#568 フェーズ計画）、Phase 2 完了後も Supabase プロジェクトを
**解約してはならない**。DB クエリ経路のみが対象。

- [ ] `src/` 全体で `.from(` / `.rpc(` を使う supabase-js 呼び出しの残存が
      ゼロであること（Phase 1 で大半は置換済み。#574「analysis/ ダッシュボードの
      Supabase 依存除去」が Phase 2 着手前に完了している前提だが、未完了なら
      残存箇所を洗い出す）
- [ ] `wrangler tail` / ネットワークログで、DB クエリ用途としての
      `*.supabase.co` への REST リクエストがゼロであること
      （Realtime WebSocket 接続は対象外・残っていて正常）
- [ ] `DB_DRIVER` フラグの分岐自体が不要になった箇所がないか
      （Phase 4 でフラグ削除予定だが、Phase 2 時点では削除しない。
      本項目は「postgrest 分岐に実際に到達していないこと」の確認）

### 6.3 機能検証（`docs/db-driver-migration.md` からの継承項目）

- [ ] ガチャを実際に1回引いてカードが付与され、overlay 演出・チャット通知が
      出ること（重複再送・上限付きカードの再抽選も可能なら確認）
- [ ] ダッシュボードの主要タブ（カード一覧・ガチャ履歴・統計・カード別所持統計・
      ガチャユーザー一覧）が切替前と同一表示になること
- [ ] Twitch トークンリフレッシュとBOTアカウント経由のチャット送信が動くこと
- [ ] 支援コードの有効化・解除が動作すること
      （`support_codes`/`user_licenses` は JWT クレーム述語の RLS 対象）
- [ ] 画像アップロード/削除で `storage_usage` の使用量が増減すること
- [ ] EventSub リプレイが正常に完了し、二重付与が発生していないこと
      （`event_id` 冪等チェックのログで確認）
- [ ] `wrangler tail` で `[db:pg]` タグのエラー・`CONNECTION_*` 系エラーを
      最低30分監視（5.2節のとおり、この監視は書き込み停止の延長ではなく
      書き込み再開後も並行して継続する）

### 6.4 シーケンス値（詳細は7章）

- [ ] 対象となる DB シーケンスが存在するか再確認（1章の grep 結果では
      ゼロだが、restore 後の実 DB で `information_schema.sequences` を
      直接確認する）
- [ ] （シーケンスが存在する場合のみ）カットオーバー時に `setval` を
      実行済みであること

## 7. ロールバック手順

**ロールバックの定義**: 「切替前の状態（Supabase を向いた状態）に戻す」こと。
**データ移行そのものは巻き戻さない・やり直しになる。** pg_dump は
Supabase 側に対して非破壊的な読み取りのみのため、Supabase 側のデータは
切替後もそのまま保持されている。

**注意**: 切替後に PlanetScale 側に新規発生した書き込みがある場合
（read-only フラグが想定どおり機能していなかった等の異常系）、
その差分データは Supabase 側には存在しない。ロールバック＝接続先を
戻すだけでは**この差分データは救済されない**。差分データをどう扱うか
（破棄する/手動で Supabase 側に反映する等）は、実際に発生した場合に
個別検討が必要であり、本ランブックでは方針を確定しない
（未決定事項として8章に明示）。

### 7.1 手順

1. Hyperdrive の接続先を Supabase に戻す。2通りの方法がある:
   - **推奨（速い）**: 既存の Hyperdrive config の接続文字列だけを
     その場で更新する（`wrangler.toml` の変更・再デプロイ不要）。
     ```bash
     wrangler hyperdrive update twica-hyperdrive-prod \
       --connection-string="<Supabase Direct connection（twica_app ロール）>"
     ```
     （`wrangler hyperdrive update` の正確なオプション体系は wrangler の
     バージョンにより変わりうるため、実施前に `wrangler hyperdrive update --help`
     で確認すること）
   - **代替**: 新規に Hyperdrive config を作成し直し（`wrangler hyperdrive create`）、
     `wrangler.toml` の `[[hyperdrive]]`/`[[env.preview.hyperdrive]]` の `id` を
     書き換えて再デプロイする（`docs/db-driver-migration.md` のセットアップ
     手順3・4と同じ操作）。config 更新が使えない場合のフォールバック。
2. `MAINTENANCE_READ_ONLY` は状況に応じて維持/解除を判断する
   （原因調査中は維持したまま Supabase への向き先だけ戻す方が安全）。
3. Supabase 側は書き込み再開可能な状態のまま保持されているため、
   Hyperdrive の向き先を戻すだけで DB アクセスは復旧する。
4. EventSub の KV 退避分がまだリプレイされていなければ、Supabase 復帰後に
   あらためてリプレイする（リプレイ先が PlanetScale から Supabase に
   変わるだけで、退避・リプレイの仕組み自体はどちらでも同じ）。
5. `MAINTENANCE_READ_ONLY` を解除し、告知（ロールバックの旨、3.3/3.4に準じた
   簡潔な文面）を行う。
6. ロールバック後、7.0節の「差分データ」が発生していないかを
   PlanetScale 側のログ・書き込み系エンドポイントのアクセスログで確認する。

## 8. 未決定事項（オーナー確認が必要）

以下は本ランブックのドラフト作成時点で確定していない。実施前に
オーナーの承認・判断が必要。

- [ ] **実施日時**: 未定（本文中 `<YYYY-MM-DD HH:MM JST>` を確定させる）
- [ ] **告知文面の最終確認**: 3章のテンプレート（トーン・想定所要時間の
      具体的な分数・配信者への配信チャネル）
- [ ] **read-only フラグの実装方式の採用可否**: 4章の設計（特に4.4節、
      オプトイン方式 vs middleware 方式 vs CI チェック併用のどれを採るか）
- [ ] **EventSub の KV 退避・リプレイの実装**: 挙動方針は #568 で確定済みだが、
      実装自体（KVへの退避処理・切替後のリプレイバッチ）はまだ存在しない。
      本ランブックのスコープ外として、別 issue 化が必要か確認
- [ ] **実際の DB サイズの再実測**: 1章の 0.334GB は 2026-07-07 時点の参考値。
      実施直前に再確認する
- [ ] **PlanetScale 側のロール/RLS 機構が Supabase と同一のセマンティクスか**:
      #665 監査待ち（5章・6.1節の権限設定手順はこの結果次第で読み替えが必要）
- [ ] **シーケンス値の扱い**: 1章の grep では DB シーケンス（SERIAL/IDENTITY）は
      ゼロと確認済みだが、`docs/planetscale-migration-audit.md`
      （本ドキュメント作成時点で未作成）による裏取り、および restore 後の
      実 DB での再確認が必要（6.4節）
- [ ] **切替方式（数分停止 vs logical replication による無停止化）**:
      #667 の検証結果待ち。本ランブックは「数分停止」方式で書いている
- [ ] **ロールバック時の差分データの扱い方針**: 7章で指摘した「切替後に
      PlanetScale側にのみ書き込まれたデータ」の扱いは未確定
- [ ] **preview でのリハーサル実施**: #666 の受け入れ条件そのもの。
      本ランブックの手順どおりに完了できることを実際に確認し、
      5.2節のダウンタイム見積りを実測値で更新する
