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
| D-day, 直前 | `MAINTENANCE_MODE=read-only` 投入（preview → prod の順、4.6節） |
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

## 4. maintenance mode の実装方式（実装済み、issue #694）

**本章は issue #694 Stage 1〜6c（マージ済み）で実装された最終仕様の記録である。
以前のドラフト（`MAINTENANCE_READ_ONLY: boolean` フラグ・案A/B/Cの検討）は
すべて置き換えられた。旧ドラフトが未決定としていた「全書き込みルートへの
適用方式」は案B（middleware 一律 + allowlist）に確定済み。**

### 4.0 状態モデル（4値）

`src/lib/maintenance/state.ts` の `MaintenanceMode`:

```ts
type MaintenanceMode =
  | 'off'                 // 通常運用
  | 'read-only'           // 計画メンテナンス。一般writeを拒否しEventSubはqueueへ退避
  | 'cutover-validating'  // DB target切替後、write解禁前の検証状態
  | 'incident-read-only'  // 障害対応。告知文言・Retry-Afterを計画停止と分けられる
```

3値（'off' 以外）はそれぞれ機械可読なエラーコードと1:1対応する
（`MAINTENANCE_ERROR_CODE_BY_MODE`、state.ts が単一の定義元）:
`maintenance_read_only` / `maintenance_cutover_validating` /
`maintenance_incident_read_only`。

### 4.1 State provider（`src/lib/maintenance/state.ts`）

`getMaintenanceState(): MaintenanceState` が現在の状態を返す。
`docs/db-driver-migration.md` の `DB_DRIVER`/`GACHA_DB_DRIVER` と同じ
「env を呼び出しのたびに読む（モジュールトップでキャッシュしない）・trim
する・不正値は安全側に倒す」パターンを踏襲している。

環境変数（すべて任意。未設定時のデフォルトは各々に記載）:

| 環境変数 | 用途 | 未設定・不正値時 |
|---|---|---|
| `MAINTENANCE_MODE` | 4値のいずれか | `'off'` にフォールバック（**タイポ等の誤設定でサービス全体を止めない**という #694 の決定。最も制限の強い `incident-read-only` 側には倒さない） |
| `MAINTENANCE_STARTED_AT` | ISO 8601 の開始時刻（内部運用向け。公開APIには出さない） | `undefined`（`Date.parse` 不能な値は無視） |
| `MAINTENANCE_EXPECTED_END_AT` | ISO 8601 の想定終了時刻（`Retry-After` 算出・UI表示に使用） | `undefined` |
| `MAINTENANCE_MESSAGE_KEY` | 告知文言の出し分けキー（`messages/ja.json` 等の `maintenance.messageKeys.*` と対応） | `undefined`（mode別デフォルト文言にフォールバック） |
| `MAINTENANCE_OPERATION_ID` | ログ相関用の内部ID（公開APIには出さない） | `undefined` |

### 4.2 write guard 方式（案B: middleware 一律 + allowlist）

以前のドラフトが「案A/B/Cのいずれを採るか未決定」としていた論点は、
**案B（middleware 一律ブロック + allowlist による個別免除）で確定済み**。

- `src/middleware.ts` の `checkMaintenanceWriteBlock()` が、`/api/` 配下かつ
  `POST`/`PUT`/`PATCH`/`DELETE`（`MAINTENANCE_GUARDED_METHODS`）のリクエストを
  他の全処理（ロケール検出・レート制限・`updateSession` 等）より **先に**評価する。
  ブロック時はレート制限バケットを消費しない（rejected request で不要な
  I/O を発生させないという #694 の受け入れ条件に対応）。
- 免除は `config/maintenance-write-surfaces.json`（書き込みsurfaceの棚卸し）で
  管理する。各エントリは `path` / `methods` / `category` / `maintenanceBehavior`
  / `reason` / `owner` / `reviewedAt` を持ち、`maintenanceBehavior` は4値:
  - `block`（デフォルト相当。allowlist未登録＝一律ブロック）
  - `allow`（mode に関わらず常時通す。現状 `/api/auth/logout` のみ）
  - `redirect`（GET専用。下記参照）
  - `queue-during-maintenance`（EventSub専用。4.3節参照）
- 実際のマッチ判定は `src/lib/maintenance/allowlist.ts` の
  `isMaintenanceWriteExempt()`（純粋関数、`matchesSurfacePath` で
  path+method を照合）。**登録漏れは常に「過剰ブロック」という安全側にしか
  倒れない**（免除されるには明示登録が必要なため）。
- ブロック時のレスポンス生成は `src/lib/maintenance/guard.ts` の
  `guardWrite()`: 503 + `{ error: { code, message, retryable: true,
  expectedEndAt? } }`、`Retry-After` ヘッダー（`expectedEndAt` から算出、
  未設定/過去日時は300秒フォールバック）、`Cache-Control: private, no-store`
  を必ず付与する（CDNが maintenance 応答を長期キャッシュして解除後も古い
  503 を配り続ける事故を防ぐため）。
- **GETだが書き込み副作用を持つルート**（OAuth開始・コールバック等）は
  middleware の一律ブロック（POST/PUT/PATCH/DELETEのみ対象）の対象外のため、
  各ルートの先頭で個別に `guardWriteRedirect()` を呼び、`/?maintenance=1`
  へ302する設計（`maintenanceBehavior: "redirect"`、対象は
  `/api/auth/twitch/login` / `/api/auth/twitch/callback` /
  `/api/auth/bot/callback` の3件。「ログインもメンテ中はブロックする」という
  オーナー決定に基づく）。

### 4.3 EventSub の扱い（`queue-during-maintenance`）

`/api/twitch/eventsub`（Webhook本体）は `maintenanceBehavior:
"queue-during-maintenance"` として allowlist に登録され、middleware の
一律ブロックを通過する。理由は #568 決定事項どおり: **メンテ中でも Twitch
へ5xxを返すと subscription が revoke されるリスクがあるため厳禁**。

- ルートハンドラ（`src/app/api/twitch/eventsub/route.ts`）は署名検証の
  **直後**・DB書き込み関数の**直前**で `getMaintenanceState()` を見て、
  `mode !== 'off'` なら `src/lib/maintenance/eventsub-park.ts` の
  `parkEventSubNotification()` で notification payload を KV
  （`RATE_LIMIT_KV` バインディングを `maintenance:eventsub:` prefix で共用、
  専用 namespace は新規に作らない方針。理由はファイル冒頭コメント参照）へ
  退避し、Twitch には通常どおり2xxを返す。TTLは7日間。
  `challenge`（webhook_callback_verification）と `revocation` はこの分岐に
  入らず従来どおり処理する。
- KV退避に失敗した場合（binding未取得・put失敗）も2xxを返す設計
  （5xxがrevoke判定材料になるという制約が退避失敗時にも優先される）。
  この「データロス」は `logger.error` で記録し、既存の errors テーブル
  記録 → Cron Worker (`twica-error-reporter`) 経由の GitHub Issue 自動起票
  に乗る。
- **リプレイ（退避データの再処理）は issue #787 で実装済み。**
  カットオーバー作業で maintenance mode を `off` に戻した後、KV に
  退避されたままの notification（ガチャ抽選・チャンネルポイント消費を
  含みうる）は以下の手順で救済する:

  1. `src/app/api/admin/eventsub-replay/route.ts`（POST）が
     `listParkedEventSubNotifications()` で KV から退避データを
     バッチ取得し、`handleRedemption` / `handleRaidNotification`
     （どちらも `src/lib/services/eventsub-redemption.ts` に切り出し済み。
     Webhook本体と同一ロジックを再利用するため、実行結果は通常のライブ
     処理と完全に同じ冪等性・DB書き込み挙動になる）を再実行する。
     成功・skip（重複/報酬不一致等の正当な終端結果）は KV エントリを
     削除し、例外発生時のみ KV エントリを残して次のエントリへ継続する
     （再試行・調査のため）。
  2. 認証は `X-Replay-Secret` ヘッダーと環境変数
     `EVENTSUB_REPLAY_SECRET` の定数時間比較。**本番/preview環境ともに
     このシークレットの事前設定（`wrangler secret put
     EVENTSUB_REPLAY_SECRET`）が前提条件**であり、未設定の場合は
     route が 500 を返す（fail-closed。設定忘れで誰でも叩ける事故を
     防ぐため）。値は `openssl rand -hex 32` 等で生成した高エントロピーな
     ランダム文字列を使うこと（推測されると誰でもDB書き込み系のリプレイを
     実行できてしまうため）。
  3. 実行は運用スクリプト `scripts/replay-maintenance-eventsub.js` を使う:
     ```
     EVENTSUB_REPLAY_SECRET=<secret> node scripts/replay-maintenance-eventsub.js --url=<対象URL>
     # 事前確認したい場合（実行・削除を伴わない）
     EVENTSUB_REPLAY_SECRET=<secret> node scripts/replay-maintenance-eventsub.js --url=<対象URL> --dry-run
     ```
     `cursor` を使って `listComplete: true` になるまで自動でページネーション
     し、`succeeded`/`skipped`/`failed`/`unknownType`/`invalidPayload` の
     合計件数を表示する。`failed` が1件でもあれば終了コード1で終わるため、
     CI以外の運用実行後にこの終了コードで成否を判断できる。`failed` に
     なったエントリは KV に残るため、原因調査後に同じコマンドを再実行すれば
     再処理される（`execute_gacha_transaction` の `event_id` UNIQUE制約による
     冪等性を前提にした設計）。`unknownType`（未対応のsubscriptionType）と
     `invalidPayload`（破損したpayload、GitHub Issueに自動起票済み）は
     終了コードには影響しないため、表示された件数を目視で確認すること。
     KV は結果整合性（eventual consistency）のため、直前の write（park/削除）が
     直後の list に反映されないことが稀にある。read-only 解除直後に実行して
     `total` が想定より少ない場合は、1分程度待ってから再実行すること。

     **正常完了の確認方法**: `--dry-run` は実行・削除を一切行わないため、
     dry-run のレスポンスの `succeeded`/`skipped`/`failed`/`unknownType`
     件数は常に 0 になる（全エントリが分類されず `outcome: "dry-run"` として
     一律報告されるだけで、これらのカテゴリ自体が使われないため）。従って
     「dry-run 実行時にこれらの件数が 0 であること」は正常完了の判定基準に
     ならない。代わりに、**本実行**（`--dry-run` 無し）を `failed` 件数が
     0 になるまで繰り返し、その後もう一度 `--dry-run` を実行して残った
     `results` の `total` を確認すること。`total` が 0 でない場合は、
     `results` 配列の各エントリの `subscriptionType` を目視で確認する
     （dry-run では未分類のため件数集計からは判別できない）。残っているのが
     `CHANNEL_POINTS_REDEMPTION_ADD`/`CHANNEL_RAID` 以外の subscriptionType
     （本実行時に `unknownType` として KV 削除されずに残ったもの。park 側と
     同じ fail-safe 設計であり、将来の subscriptionType 対応漏れを検知する
     ためのものなので、残っていても即座の対応は不要）だけであれば正常完了と
     みなせる。KV 削除に失敗したエントリ（`deleteParkedEntrySafely` が warn
     ログのみで処理を継続する設計）が TTL 失効まで残ることもあり得るため、
     **必ずしも残件数が 0 件になるわけではない**ことに注意すること。
  4. 本routeは `maintenanceBehavior: "block"` として allowlist に登録
     済み（`/api/twitch/eventsub` 本体とは異なり `queue-during-maintenance`
     ではない）。**メンテナンス解除後（mode=off）にのみ実行する運用**の
     ため、メンテ中に誤って叩いても他の書き込みと同様にブロックされる。

### 4.4 CI enforcement（`scripts/check-maintenance-surfaces.js`）

新しい書き込みルートを追加した際に allowlist への登録漏れを機械的に
検出する（push・PRごとにCI実行、`npm run check:maintenance-surfaces`）:

- `src/app/api/**/route.ts` を TypeScript Compiler API で走査し、
  `POST`/`PUT`/`PATCH`/`DELETE` を named export する全ルートを抽出する
  （単純grepではなくAST解析。`export { X } from './other'` のような
  静的に解決できない re-export は fail-closed でエラーにする）。
- 実ルートと `config/maintenance-write-surfaces.json` を突き合わせ、
  **登録漏れ**（route はあるが inventory に無い）と **stale entry**
  （inventory にあるが route が無い）の両方をエラーにする。
- inventory 自体のスキーマ検証（必須フィールド・`maintenanceBehavior` の
  4値制約・`redirect` は methods が `['GET']` のみ・`block` は GET を
  含まない・path+method の重複禁止 等）も同じスクリプトが担う。
- `allow`/`queue-during-maintenance`（＝ブロックを免除される、最もリスクの
  高いエントリ）の `reviewedAt` が180日超過した場合は、CIを落とさない
  軽量な警告のみ出す（免除設定がまだ妥当か再確認を促す）。

### 4.5 UI（利用者・管理者向け表示）

- **Public status endpoint**: `GET /api/maintenance-status`
  （`src/app/api/maintenance-status/route.ts`）。未認証で呼べる
  （ログイン画面自体がメンテ中でも状態表示できる必要があるため）。
  `getMaintenanceState()` のうち機密情報（`startedAt`・`operationId`）を
  除いた `{ mode, expectedEndAt?, publicMessageKey? }` のみを返す。
  `Cache-Control: private, no-store` 必須。
- **状態共有Context**: `src/components/MaintenanceStatusProvider.tsx`
  （`dashboard/layout.tsx` に1つだけマウント）。マウント時に即時fetch、
  以降60秒間隔でポーリングし、`useMaintenanceStatus()` hookで配下の
  コンポーネントに配る。1ページ = 1polling系列にすることで、書き込み
  ボタンごとに個別fetchするコストを避けている。
- **バナー**: `src/components/MaintenanceBanner.tsx`。可視表示
  （`MaintenanceBanner`）とスクリーンリーダー向け通知
  （`src/components/MaintenanceAnnouncer.tsx`、`aria-live`）を1コンポーネントに
  統合し、片方だけ組み込み忘れる事故を防ぐ。
- **書き込みボタンのdisable**: 各書き込みコンポーネント（`CardManager.tsx`
  等、Stage 6b/6cで主要+20コンポーネントに適用済み）が
  `useMaintenanceStatus()` で `mode !== 'off'` を判定し、ボタンを事前disable
  する。503を実際に受けた場合のpost-failure表示（`src/lib/maintenance/client.ts`
  の `parseMaintenanceError()` でcode based判定）と二段構え。
- **overlay**: 通常表示を継続し、maintenance状態はdebug時のみ表示する
  設計（配信画面に一般利用者向けの通知を出さない）。

### 4.6 activation / deactivation 手順

env 変更はビルド不要で秒単位で反映される（Cloudflare では新デプロイ扱い）。
Cloudflare の secret は `wrangler versions secret put` → `wrangler versions
deploy` の2段で反映する（`wrangler.toml` の変更・再デプロイは不要）。

**重要な既知の落とし穴**: ローカル既定の wrangler（本リポジトリでは
4.61.0系）は、本番/preview Worker に対して `versions secret put` を実行した
際に**無言で exit 1 する**バグがある（診断メッセージが一切出ない）。
必ず `npx wrangler@4.112.0` とバージョンを明示すること。

有効化（preview の例、`read-only` へ切替）:

```bash
echo "read-only" | npx wrangler@4.112.0 versions secret put MAINTENANCE_MODE --env=preview
# 出力された version-id を100%トラフィックへデプロイする
npx wrangler@4.112.0 versions deploy <version-id>@100% --env=preview -y
```

本番の場合は `--env=preview` を `--env=""`（空文字。`wrangler.toml` の
デフォルト環境が本番を指すため）に置き換える。

無効化（`off` へ戻す。secret を空文字にはできないため、明示的に `off` を
設定する）:

```bash
echo "off" | npx wrangler@4.112.0 versions secret put MAINTENANCE_MODE --env=preview
npx wrangler@4.112.0 versions deploy <version-id>@100% --env=preview -y
```

反映確認は `GET /api/maintenance-status`（4.5節）を叩くのが最速
（未認証で呼べる）。ただし allowlist・EventSub queue経路まで含めた
「全write surfaceが期待通り動くか」の確認には次節のスクリプトを使う。

### 4.7 確認手順: `scripts/probe-maintenance-write-surfaces.js`

issue #694 の受け入れ条件「previewでmode on/offと全主要write surfaceを
検証している」に対応する運用スクリプト（#694 Stage 7 で追加）。
`config/maintenance-write-surfaces.json` の全エントリに対し、実際に
稼働中のWorkerへ未認証リクエストを送り、期待通りの応答が返るかを
機械的に検証する。**CIでは実行しない**（外部Workerへの実リクエストを
伴うため）。

```bash
# 4.6節で対象環境の MAINTENANCE_MODE を off 以外にしてから実行すること
node scripts/probe-maintenance-write-surfaces.js --url=https://twica-preview.tsubasa-azumagakito.workers.dev
# または
npm run probe:maintenance -- --url=https://twica-preview.tsubasa-azumagakito.workers.dev
```

検証内容: `block` エントリは503+`error.code`が`maintenance_*`であること、
`redirect` エントリ（GET）は302+`Location`が`/?maintenance=1`を含むこと、
`allow`/`queue-during-maintenance` エントリは503でないこと。対象環境が
`MAINTENANCE_MODE=off`のままだと`block`系エントリが1件も503を返さず、
その場合はスクリプトが早期終了して分かりやすいエラーを出す（詳細は
`node scripts/probe-maintenance-write-surfaces.js --help`）。

### 4.8 既知の残課題

- ~~issue #785~~: `src/app/battle/layout.tsx` に `MaintenanceStatusProvider`
  が無く `startBattle` ボタンの事前disableがno-opだった問題、および
  `TwitchLoginButton.tsx` がマウント時1回しかmaintenance statusを
  取得しない残余レースは、issue #785（commit `dafef83`）で解消済み。
- ~~EventSubリプレイ未実装~~（4.3節）: issue #787 で
  `src/app/api/admin/eventsub-replay/route.ts` と運用スクリプト
  `scripts/replay-maintenance-eventsub.js` を実装し解消済み。詳細は
  4.3節を参照。

## 5. pg_dump/restore の実行手順とダウンタイム見積り

リポジトリ内に pg_dump/pg_restore 関連の既存スクリプトは**見つからなかった**
（`scripts/` 配下を確認。`scripts/verify-db-schema.js` は切替前後のスキーマ照合
専用で、ダンプ/リストア自体は行わない）。以下はコマンドラインでの手順案。
再現性のため、実施が近づいた段階で `scripts/` にラップスクリプト化することを推奨する。

### 5.1 手順

1. **read-only 化**: preview → prod の順で `MAINTENANCE_MODE=read-only` を投入
   （4.6節の手順）。書き込み系エンドポイントが 503 を返すことを1件確認する
   （`scripts/probe-maintenance-write-surfaces.js` で全書き込みsurfaceを
   機械的に確認できる、4.7節参照）。
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
   テーブル数・関数・トリガーが想定件数と大きく乖離していないことを
   目視確認する。**想定件数は migration ファイル由来の 25/約28/11 ではなく、
   prod 実体由来の値**: テーブル **23**（battles/battle_stats が prod に
   存在しないため）・トリガー **9**（11個のうち `update_battle_stats_trigger` /
   `update_battle_stats_updated_at` の2個は battle 系テーブル上のため存在
   しない）・関数 27〜28（`update_battle_stats` 関数の prod 実在は未確認、
   リハーサル時に実測して確定させる）。
5. **PlanetScale Postgres への restore**:
   ```bash
   pg_restore --no-owner --no-privileges --clean --if-exists \
     -d "postgresql://<planetscale-role>:<password>@<planetscale-host>:5432/<db>?sslmode=require" \
     twica_prod_*.dump
   ```
   - `--clean --if-exists`: preview リハーサルでの再実行を安全にするため。
     本番の初回カットオーバーでは対象 DB が空である前提のため実質 no-op。
6. **スキーマ照合**: `DATABASE_URL=<PlanetScale接続文字列> node scripts/verify-db-schema.js`
   を実行し、`src/lib/db/schema.ts` との差分・SELECT smoke を確認する
   （既存スクリプトをそのまま流用可能。CI では実行しない運用も踏襲）。
   **注意: 「差分ゼロ・exit 0」は期待できない。** pg_dump/restore は prod の
   実スキーマをそのまま移送するため、既知のスキーマドリフト（#625:
   `battles`/`battle_stats` テーブルが prod に存在しない・`cards` の 8 列が
   prod に欠落）は新 DB にもそのまま引き継がれる。スクリプトは schema.ts を
   正として双方向で差分検出し、schema.ts 側の全テーブルへ SELECT smoke を
   発行するため、**期待される出力は次の通り**（これ以外の差分が出た場合のみ
   異常と判断する）:
   - table missing in DB × 2（battles / battle_stats）
   - column missing in DB × 8（cards: card_number/hp/atk/def/spd/
     skill_type/skill_name/skill_power）
   - SELECT smoke failure × 2（battles / battle_stats、テーブル不在のため）
   - 終了コード **1**（差分ありのため非ゼロ終了が正常。exit 0 を成功条件に
     した自動化スクリプトでラップしないこと）
7. **シーケンス値の確認**（6章）。
8. **Hyperdrive の接続先を PlanetScale に切り替える**（`wrangler hyperdrive
   update` または config 再作成。詳細は 7章ロールバック手順と対になる操作）。
9. **最小限の書き込み系疎通確認**を1系統実施（例: ガチャ実引き1回）。
10. **read-only 解除**（prod → preview の順、または一括）。
11. **EventSub リプレイ**: メンテナンス中に KV へ退避された payload を
    リプレイする（4.3節、**実装済み**。`scripts/replay-maintenance-eventsub.js`
    を dry-run → 本実行の順で実行し、`failed` 件数が0になることを確認する）。
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
      **既知ドリフト（5.1 手順6の注意書き参照）以外の**差分ゼロ・
      実在する全テーブルへの SELECT smoke 成功
- [ ] 実在する全テーブルの行数が dump 時点の Supabase 側件数と一致
      （read-only 化後に dump しているため一致するはず。不一致は
      read-only が効いていなかった可能性を示す重大な兆候）
- [ ] **9個**のトリガー・27〜28個の plpgsql 関数が復元されている
      （期待件数の根拠は 5.1 手順4 の注意書き参照。battle 系 2 トリガーは
      prod に存在しないため 11 個ではない。`pg_restore -l` の内容と一致するか、
      または `\df`/`\dg` 相当の information_schema クエリで確認）
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
2. `MAINTENANCE_MODE`（`read-only` のまま維持するか、原因判明後に
   `incident-read-only` へ切り替えるか）は状況に応じて判断する
   （原因調査中は維持したまま Supabase への向き先だけ戻す方が安全）。
3. Supabase 側は書き込み再開可能な状態のまま保持されているため、
   Hyperdrive の向き先を戻すだけで DB アクセスは復旧する。
4. EventSub の KV 退避分がまだリプレイされていなければ、Supabase 復帰後に
   あらためてリプレイする（リプレイ先が PlanetScale から Supabase に
   変わるだけで、退避・リプレイの仕組み自体はどちらでも同じ）。
5. `MAINTENANCE_MODE` を `off` に戻し、告知（ロールバックの旨、3.3/3.4に準じた
   簡潔な文面）を行う。
6. ロールバック後、7.0節の「差分データ」が発生していないかを
   PlanetScale 側のログ・書き込み系エンドポイントのアクセスログで確認する。

## 8. 未決定事項（オーナー確認が必要）

以下は本ランブックのドラフト作成時点で確定していない。実施前に
オーナーの承認・判断が必要。

- [ ] **実施日時**: 未定（本文中 `<YYYY-MM-DD HH:MM JST>` を確定させる）
- [ ] **告知文面の最終確認**: 3章のテンプレート（トーン・想定所要時間の
      具体的な分数・配信者への配信チャネル）
- [x] **read-only フラグの実装方式の採用可否**: issue #694 Stage 1-7で実装・
      オーナー承認済み。案B（middleware一律 + allowlist、4.2節）に確定
- [x] **EventSub のリプレイ実装**: 退避（KVへの一時保存、4.3節）は#694で
      実装済み。**リプレイ（退避分の再処理）は issue #787 で実装済み**
      （`src/app/api/admin/eventsub-replay/route.ts` +
      `scripts/replay-maintenance-eventsub.js`、手順は4.3節参照）。
      実行には環境変数 `EVENTSUB_REPLAY_SECRET` の事前設定が本番・preview
      両環境で必要（未設定の場合routeは500でfail-closed）。2026-07-19、
      本番・preview両環境で `openssl rand -hex 32` により生成した値を
      `wrangler versions secret put` で設定・デプロイ済み（値は非公開）。
      本番で認証エラー(403)が正しく返ることを実機確認済み
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
- [ ] **既知スキーマドリフトの扱い**（#625/#628、2026-07-17 のオーナー確認で
      battle 機能は「廃止」ではなく「将来実装のため温存」と確定）:
      - `battles`/`battle_stats` テーブル: prod に存在しないため、pg_dump/restore
        では新 DB にも作成されない。**現状のまま移行してよい**（battle 実装を
        再開する時点で、新 DB 向けにテーブル作成 migration を新規に書く。
        migration は追記専用・履歴改変をしない運用のため、既存の 00002 を
        書き換えたり再適用したりはしない）。この方針で問題ないかオーナー最終確認
      - `cards` の 8 列（card_number は採番用・残り 7 列が battle 系。列名一覧は
        `src/lib/db/cards-safe-columns.ts`、経緯は #625）: prod に欠落したまま
        移行すると、新 DB でも `CARDS_SAFE_COLUMNS` フォールバックが恒久的に
        必要になる。**切替前に prod へ列追加 migration を適用してドリフトを
        解消しておくか**、ドリフトごと移送するかをオーナー判断
        （解消しておく方がコード側のフォールバックを将来削除できる）
- [ ] **切替後の migration 適用手段と migration 履歴の移送**: 現行の
      `supabase db push` は Supabase CLI 前提であり、PlanetScale 切替後に
      新規 migration をどう適用するか（plain psql / 独自スクリプト等）は未決定。
      また `supabase_migrations.schema_migrations`（履歴テーブル）が pg_dump で
      新 DB へ移送されるか（スキーマ指定なしの dump に含まれるか・接続ロールの
      読み取り権限）も未検証。リハーサル時に実測し、適用手段とセットで確定させる。
      なお `.github/workflows/deploy-cloudflare.yml` の `Apply Supabase
      migrations` ステップがデプロイ毎に旧 Supabase へ `supabase db push` を
      自動実行しているため、カットオーバー時にこのステップの無効化または
      向き先の扱いを決めておく必要がある（未決定のまま切替えると、以後の
      新規 migration が新 DB に適用されないサイレントドリフトになる）
