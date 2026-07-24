# PlanetScale Postgres 移行監査（履歴: #665 / #667）

> この文書は移行前の調査・判断記録です。現行 runtime の正本ではありません。

親issue #568（Supabase → PlanetScale Postgres 移行）の子issue #665・#667に対応する調査結果。
`docs/history/migration/DB_PHASE2_RUNBOOK.md`（#666）から参照される想定のドキュメント。

**実施日: 2026-07-10。コード変更・実インフラ操作なし。検証はすべてローカルDocker上で実施し、
実際のSupabase/PlanetScale/Cloudflareリソースには一切接続していない。**

## 1. サマリ

- **移行リスク評価: 低い〜中程度。**
  - `supabase/migrations/` 全65ファイルは、Supabase固有オブジェクト（`auth`スキーマの関数、
    `realtime`スキーマ、`anon`/`authenticated`/`service_role`ロール）をダミー実装で補えば、
    **Postgres本体の文法・実行としてはエラーなく完走した**。これらのダミー実装が必要になる
    こと自体はPhase 2で想定内（#568・`docs/db-driver-migration.md`のRLS/ロール設計を踏襲）。
  - 主キー（またはreplica identity相当）を持たないテーブルは**ゼロ**（全25テーブルがUUID主キー
    または複合UUID/TEXT主キーを持つ）。DBシーケンス（SERIAL/IDENTITY/`CREATE SEQUENCE`）も
    **ゼロ**。この2点はlogical replication・pg_dump/restore方式のどちらを採っても大きな障害には
    ならない、という意味でリスクを下げる材料。
  - 一方で、1件だけ実運用上のリスクを示す **WARNING**（`SET LOCAL statement_timeout can only
    be used in transaction blocks`）を検出した。詳細は3章参照。
  - #667（logical replication可否）は、公式ドキュメント上は**採用可能**（PlanetScaleが
    Supabaseからのlogical replication subscriberになる専用ガイドが存在する）が、Supabase側の
    IPv4アドオン有効化・direct connection必須など運用上の前提条件があり、「無停止化」を
    最終決定する前に#666ランブックのオーナー確認が必要（本ドキュメントは技術的な可否のみ判定）。

- **検証に使用したPostgresバージョン: `postgres:17`（Docker公式イメージ、実際は17.10、
  Debian 17.10-1.pgdg13+1）。**
  WebSearchで確認した結果、PlanetScale Postgresは **PostgreSQL 17系・18系をベースにしており、
  16系はサポート対象外**（[PlanetScale Postgres compatibility](https://planetscale.com/docs/postgres/postgres-compatibility)）。
  タスク指示は「特定できない場合は16系を使う」だったが、今回はバージョンを特定できたため
  17を採用した（18ではなく17を選んだ理由: 17がPlanetScale Postgres GA当初からの版であり、
  既存DBの多くが17系である可能性が高いため。18固有の非互換は本監査の範囲外）。

## 2. タスク1: migration移植監査の結果

### 2.1 検証環境

```
docker run -d --name twica-pg-audit -e POSTGRES_PASSWORD=audit -p 5433:5432 postgres:17
```
ポート5433を使用（ホストの5432・既存コンテナと衝突なしを`docker ps`で事前確認済み）。
作業完了後、`docker rm -f twica-pg-audit` でコンテナを削除済み（4章参照）。

### 2.2 拡張機能

| 拡張 | 結果 |
|---|---|
| `uuid-ossp` | `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";` は成功。`uuid_generate_v4()` の呼び出しも確認済み |
| `pgcrypto` | `00073_add_analysis_dashboard_rpcs.sql` が明示的に `CREATE EXTENSION IF NOT EXISTS pgcrypto;` を実行しており、成功 |

migration内で`CREATE EXTENSION`が使われているのはこの2件のみ（`grep -n "CREATE EXTENSION"`で全件確認）。

### 2.3 65ファイルの適用結果

3パターンで検証した（すべて`postgres:17`、ファイル名の連番順に`psql -f`で適用、
`ON_ERROR_STOP=1`）。

| パターン | 結果 |
|---|---|
| ①素のPostgres（Supabase固有オブジェクトなし） | `00004_add_twitch_tokens_to_users.sql`（4番目のファイル）で失敗。`ERROR: schema "auth" does not exist`（`USING (auth.uid()::text = twitch_user_id)`） |
| ②`auth`/`realtime`スキーマ・関数のダミーのみ追加 | `00008_add_streamer_additional_gacha_rewards.sql`で新たに失敗。`ERROR: role "service_role" does not exist`。以降、`service_role`/`anon`ロード不在で計19ファイルがエラー（GRANT/CREATE POLICY TO句） |
| ③`auth`/`realtime`スキーマ・関数 + `anon`/`authenticated`/`service_role`ロールをダミー追加 | **65ファイル全て`ON_ERROR_STOP=1`でエラーなく完走**（`echo $?`で各ファイルの成功を確認、最後の`00073`まで到達） |

パターン③で使用したダミー実装（実測で動作確認済み）:

```sql
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'anon'::text $$;

CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text,
  extension text
);
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
```

**Supabase固有依存の内訳（実測でgrep確認）:**

| 依存 | 該当ファイル | 内容 |
|---|---|---|
| `auth.uid()` / `auth.jwt()` / `auth.role()` | 00004, 00006, 00008, 00012, 00017（コメントのみの00024を除く） | RLSポリシーの`USING`/`WITH CHECK`句 |
| `realtime.messages` / `realtime.topic()` | 00034 | Supabase Realtimeのprivateチャンネル向けRLSポリシー |
| `anon` / `authenticated` / `service_role`ロールへの`GRANT`・`CREATE POLICY ... TO` | 00008, 00011, 00013, 00015〜00019, 00021, 00024, 00027, 00030〜00033, 00036, 00038〜00040, 00045〜00047, 00050〜00052, 00059, 00063〜00065, 00067, 00069, 00070, 00073（計28ファイル） | PostgREST/Supabase標準ロールへの権限付与・RLSポリシー対象ロール指定 |
| `storage.*` | 該当なし（`storage.`でのgrep一致は0件。`00006_add_storage_tracking.sql`はアプリ独自の`storage_usage`テーブルで、Supabase Storageスキーマとは無関係） | - |

**移行時の扱いについて（#568の既定路線を踏まえた所見）:**
- `auth.*`はアプリ層のCookie認証に置き換わる前提（#568決定済み、`00024`のコメントにも明記あり）。
  よってPlanetScale移行後、`auth.uid()`/`auth.jwt()`/`auth.role()`に依存するRLSポリシーは
  **実質的に無意味化する**（`docs/db-driver-migration.md`が示す通り、pg直結ではJWTクレームが
  存在せずこれらの述語は常に偽になる）。今回のダミー実装のように「文法上は動くが意味を持たない
  スタブ」を後々まで残すのではなく、移行完了後はこれらのポリシーを**app層認可に一本化して
  削除する**方向が望ましい（現状はまだPhase 1のため、`grant service_role to twica_app`で
  service_role系ポリシーだけ迂回している状態）。
- `realtime.messages`への依存（00034）は、`docs/history/migration/DB_PHASE2_RUNBOOK.md`が明記する通り
  SupabaseプロジェクトをPhase 3まで残す設計と整合的。Phase 2（DBプロバイダ切替）の対象外であり、
  PlanetScale側に`realtime`スキーマを作る必要はない（Supabase Realtimeを使い続けるため）。
- `service_role`/`anon`/`authenticated`ロードは、PlanetScale側で同名のロールを作成するか
  （ダミー実装と同じ発想）、`docs/db-driver-migration.md`が既に採用している
  「`grant service_role to twica_app`でservice_role権限を継承させる」方式をそのまま流用できる
  ことを今回のダミーロール実験で裏取りできた（`CREATE ROLE ... NOLOGIN`で権限を持つロールを
  作り、アプリ用ロールをメンバーにする、という構造がPostgres標準機能のみで完結するため）。

### 2.4 実データでの確認結果（`ON_ERROR_STOP=1`で全65ファイル適用後のDBに対して実行）

| 確認項目 | 結果 |
|---|---|
| plpgsql関数の総数 | **22個**（`docs/history/migration/DB_PHASE2_RUNBOOK.md`の概算「約28」より少ない。理由は同ファイルの推定が`CREATE [OR REPLACE] FUNCTION`の出現回数ベースの概算で、`00073`など後続migrationが既存関数を`CREATE OR REPLACE`で上書き・改名した分の重複を除いていないため。今回の22は実DBに存在する一意な関数名の実測値であり、より正確） |
| `execute_gacha_transaction`の存在・定義可読性 | 存在確認済み。`\df+ execute_gacha_transaction`で定義取得成功（戻り値`jsonb`、引数`p_event_id text, p_user_twitch_id text, p_user_twitch_username text, p_card_id uuid, p_streamer_id uuid, p_reward_cost integer DEFAULT NULL, p_reward_id text DEFAULT NULL`、`SECURITY INVOKER`、`volatile`） |
| トリガー総数 | **11個**（`docs/history/migration/DB_PHASE2_RUNBOOK.md`の記載と一致）。一覧: `update_announcements_updated_at`(announcements), `update_battle_stats_trigger`(battles), `update_battle_stats_updated_at`(battle_stats), `update_cards_updated_at`(cards), `trg_sync_channel_point_usage_stat`(gacha_history), `update_streamer_chat_sender_settings_updated_at`(streamer_chat_sender_settings), `update_streamers_updated_at`(streamers), `update_support_inquiries_updated_at`(support_inquiries), `update_twitch_bot_accounts_updated_at`(twitch_bot_accounts), `trg_sync_card_owner_stat`(user_cards), `update_users_updated_at`(users) |
| 生成カラム(generated column) | **1件のみ**: `cards.rarity_order`（`GENERATED ALWAYS AS (CASE rarity WHEN 'legendary' THEN 1 WHEN 'epic' THEN 2 WHEN 'rare' THEN 3 WHEN 'common' THEN 4 ELSE 5 END) STORED`相当）。他に生成カラムなし |
| JSONB / TEXT[]型カラム | JSONB 7件（`battles.battle_log`, `battles.opponent_card_data`, `errors.context`, `streamers.card_pack_names`, `streamers.custom_rarities`, `streamers.gacha_sound_rules`, `streamers.pack_rarity_weights`, `streamers.rarity_weights`）+ TEXT[] 2件（`twitch_bot_accounts.scopes`, `users.twitch_scopes`）計10件 |
| `SELECT ... FOR UPDATE`を含む関数 | **4件**: `activate_support_code`, `exchange_duplicate_card_for_stones`, `execute_gacha_transaction`, `rename_card_pack`（いずれも行ロックを使った並行実行安全なトランザクション関数。Postgres標準機能のみで、PlanetScale移行後もそのまま動作する見込み） |
| RLSポリシー総数 / RLS有効テーブル数（参考） | ポリシー30件、RLS有効テーブル25件（全テーブル）。#568のapp層認可移行の対象範囲の目安として記録 |
| テーブル数 / カラム数 / インデックス数（参考） | 25テーブル、229カラム、91インデックス |

### 2.5 #667向けの追加調査（logical replication可否に直結する項目）

| 確認項目 | 結果 |
|---|---|
| 主キー（またはreplica identity相当）を持たないテーブル | **0件**（クエリ結果は空）。タスク指示に含まれていたクエリ文には`join pg_namespace n on n.relnamespace=c.oid`という誤り（`pg_namespace`に`relnamespace`列は存在しない）があったため、`c.relnamespace=n.oid`に修正の上、全25テーブルを対象に実行し確認した |
| 各テーブルの`relreplident`（replica identity種別） | 全25テーブルとも`d`（DEFAULT = 主キーに基づく）。`FULL`や`NOTHING`は無し。主キーが全テーブルに存在するため、logical replicationでのUPDATE/DELETEレプリケーションに支障なし |
| 主キーの型 | 25テーブル中23テーブルがUUID単一主キー（`gen_random_uuid()`/`uuid_generate_v4()`系）。複合主キー2件（`card_owner_stats`: `card_id`+`streamer_id`+`user_twitch_id`のUUID/TEXT複合、`channel_point_usage_stats`: `user_twitch_id`+`streamer_id`のTEXT/UUID複合）。`storage_usage`は`user_prefix`(varchar)単一主キー、`blob_files`は`url`(text)単一主キー |
| シーケンス一覧 | **0件**（`information_schema.sequences`が空）。`docs/history/migration/DB_PHASE2_RUNBOOK.md`の「SERIAL/IDENTITY列・DBシーケンスはゼロ」というgrepベースの推定を、実DBのカタログ照会で裏付けた。全テーブルがUUID（またはvarchar/text）主キーを採用しており、`nextval()`に依存する列は存在しない |

**この結果が持つ意味（#667への直接的な影響）**: logical replicationの既知の弱点である
「①PK/replica identity無しテーブルのUPDATE/DELETEが複製できない」「②シーケンスの`nextval`値が
複製されずカットオーバー時に手動`setval`が必要」の**両方とも、このスキーマでは実質的にリスクが
消える**（①該当テーブル0件、②シーケンス自体が存在しないため`setval`手順そのものが不要）。
これはlogical replication方式・pg_dump/restore方式のどちらを採るかの判断において、
logical replication側の相対的な導入コストを下げる材料になる。

## 3. タスク1で見つかった問題点・要対応事項

### 3.1 `SET LOCAL statement_timeout`がトランザクション外では効かない（要対応）

`00051_add_card_owner_stats.sql`の適用中、以下のWARNINGを検出した:

```
psql:/migrations/00051_add_card_owner_stats.sql:160: WARNING:  SET LOCAL can only be used in transaction blocks
```

該当箇所（同ファイル155〜160行目付近）:

```sql
-- 既存 user_cards からの初期バックフィル。
-- user_cards が大規模な場合に supabase db push の statement_timeout で
-- マイグレーション全体がロールバックされるのを防ぐ。マイグレーションは
-- トランザクション内なので SET LOCAL はこのトランザクション内に限定される。
-- ON CONFLICT DO UPDATE により再実行は冪等。
SET LOCAL statement_timeout = 0;

INSERT INTO card_owner_stats ( ... ) SELECT ... FROM user_cards ...
ON CONFLICT (...) DO UPDATE ...;
```

コメントにある通り、この`SET LOCAL`は**「`supabase db push`がmigrationファイル1本を
1トランザクションとしてラップする」という前提**に依存した書き方になっている。
Supabase CLIはこの前提で動くためこれまで問題にならなかったが、今回のようにPlanetScale側の
移行ツール・スクリプトが`psql -f`のような**オートコミット（ファイル全体を1トランザクションで
包まない）方式**でmigrationを再生した場合、`SET LOCAL`の効果は直後の1文（＝`SET LOCAL`文自身の
暗黙トランザクション）で終わってしまい、後続の`INSERT`文には**適用されない**。
その場合、`user_cards`が大きい環境では`INSERT`がデフォルトの`statement_timeout`で
中断される可能性がある（今回の検証データはテーブルが空でこの問題は顕在化しなかったため、
WARNINGとしてのみ検出。実害は未確認）。

**対応案**: PlanetScaleへ本番migrationを再生する際は、①各migrationファイルを明示的に
`BEGIN; ... COMMIT;`で囲む（Supabase CLIと同じセマンティクスを再現）、または
②このファイルに限り`SET statement_timeout = 0;`（`LOCAL`なし・セッションスコープ）に
書き換えるか、migration適用スクリプト側で`statement_timeout`を無効化してから流す、
のいずれかを`docs/history/migration/DB_PHASE2_RUNBOOK.md`の5章（pg_dump/restore手順）に反映することを推奨する。
なお`grep -rn "SET LOCAL" supabase/migrations/*.sql`でこのファイル1件のみと確認済みで、
他に同種のパターンはない。

### 3.2 その他

- 上記以外にエラー・WARNINGは検出されなかった（全65ファイルがクリーンに適用完了）。
- `docs/history/migration/DB_PHASE2_RUNBOOK.md`のplpgsql関数数の記載（約28）は実測値22に更新が必要
  （2.4節参照）。トリガー数11・テーブル数25・シーケンス0件はいずれも同ランブックの記載と一致し、
  実測で裏取りできた。

## 4. タスク2: #667 logical replication可否のデスク調査

### 4.1 PlanetScale PostgresはSupabaseからのlogical replication subscriberになれるか

**なれる。** PlanetScaleは"Migrate from Supabase to PlanetScale"という専用の公式移行ガイドを
提供しており（[docs](https://planetscale.com/docs/postgres/imports/supabase)）、
Supabaseをlogical replicationのpublisher、PlanetScale Postgresをsubscriberとする方式が
文書化されている。

### 4.2 Supabase側でpublisherとして必要な設定

- Supabaseは**デフォルトで`wal_level = logical`が有効**であり、追加設定は基本的に不要
  （もし`logical`になっていない場合はSupabaseサポートへの連絡が必要、との情報あり）。
- **Direct connection（pooler不可・port 5432）が必須。** 公式ガイドは
  「`pg_dump`・`CREATE PUBLICATION`・`CREATE SUBSCRIPTION`にはdirect connectionのhost/port 5432を
  使うこと。Supabaseのpooledエンドポイントはlogical replicationに使えない」と明記している。
- **IPv4アドオンが必要。** Supabaseの外部向けdirect connectionはデフォルトでIPv4が無効化されて
  おり、「Connect」→「IPv4 add-on」から有効化する必要がある。有効化時に短時間のダウンタイムが
  発生しうる、との記載あり。
- PlanetScale側の移行用ロールには`pg_read_all_data`, `pg_write_all_data`,
  `pg_create_subscription`, `postgres`の権限が必要。

### 4.3 推奨される移行手順（初期コピー→CDC同期→カットオーバー）

1. **準備**: PlanetScale側にDB作成（リージョン・ストレージタイプ・アーキテクチャ選択）。
   ディスクサイズはソースDBの150%以上を推奨（データ増加・bloat対策）。
   `max_worker_processes`を4→10以上に増やすことで初期コピーを高速化。
2. **Supabase側でIPv4アドオン有効化。**
3. **スキーマのみを`pg_dump --schema-only`でコピーし、PlanetScale側に`psql`で流し込む。**
   （このスキーマ投入の段階が、本監査のタスク1で検証した「65ファイルのmigration適用」に相当する）
4. **Supabase側で`CREATE PUBLICATION`、PlanetScale側で`CREATE SUBSCRIPTION`を作成**
   （`copy_data = true`で初期データコピーも兼ねる）。
5. **初期テーブル同期（tablesync worker）** → **定常状態のWALストリーミング（apply worker）**
   の2フェーズで進行。`pg_subscription_rel.srsubstate`（`i`/`d`/`s`/`r`）でテーブルごとの
   同期状態を、レプリケーション遅延は`received_lsn`と`pg_current_wal_lsn()`の比較で監視できる。
6. **シーケンスの`setval`**: logical replicationは`nextval`値を複製しないため、本来は
   カットオーバー直前に`pg_sequences`から取得した値で`setval`する必要がある。
   **ただし本監査の2.5節の通り、twicaのスキーマにはDBシーケンスが1件も存在しないため、
   この手順自体が不要**（twica固有の重要な結論）。
7. **カットオーバー**: レプリケーション遅延が解消（`received_lsn`が`pg_current_wal_lsn()`に追従）
   したことを確認後、アプリケーションの接続先をPlanetScaleに切替。切替後の新規書き込みは
   Supabase側に逆方向レプリケーションされない点に注意（一方向のみ）。
   フォールバックのためSupabase側を数日残しておくことが推奨されている。
8. **後片付け**: PlanetScale側の`DROP SUBSCRIPTION`、Supabase側の`DROP PUBLICATION`。

### 4.4 #667の結論

**logical replicationは技術的に採用可能。** PlanetScale公式にSupabase専用の移行ガイドがあり、
twicaのスキーマ（本監査で確認した全テーブルPK保有・シーケンス無し）はlogical replicationの
弱点（PK無しテーブルのUPDATE/DELETE不可、シーケンス値の手動復旧）のいずれにも該当しない。

**採用する場合の注意点:**

- **シーケンスの`setval`問題は本件では発生しない**（2.5節の通りシーケンス自体が存在しないため）。
  `docs/history/migration/DB_PHASE2_RUNBOOK.md`6章のチェックリストにある「シーケンス存在の再確認」は今回のDocker
  検証でも裏付けが取れたが、念のため本番Supabase DBに対しても
  `select * from pg_sequences;`で最終確認することを推奨する（本監査はローカルDocker環境での
  migration適用結果に基づくものであり、本番DB自体を検査したものではない）。
- **PK無しテーブルも本件では発生しない**（2.5節）。
- Supabase側でIPv4アドオンを有効化する必要があり、これ自体が短時間のネットワーク断を
  引き起こす可能性がある点は、`docs/history/migration/DB_PHASE2_RUNBOOK.md`のダウンタイム見積り（5.2節）に
  織り込む必要がある。
- `docs/history/migration/DB_PHASE2_RUNBOOK.md`が採用している「数分の書き込み停止＋pg_dump/restore」方式と
  「logical replicationによるほぼ無停止化」方式は、どちらもtwicaのスキーマ上は実行可能という
  意味で優劣がつかない。最終的な採否はダウンタイム許容度・実装/運用の複雑さ
  （IPv4アドオン・レプリケーション監視・カットオーバー手順の複雑さ増）とのトレードオフであり、
  オーナー判断が必要（#666の未決定事項としても明記されている）。
- 3.1節で指摘した`SET LOCAL statement_timeout`の問題は、logical replication方式を採る場合は
  スキーマ投入（`pg_dump --schema-only`→`psql`流し込み）の段階で同様に発生しうるため、
  どちらの移行方式を採る場合でも対応が必要。

## 5. 参考にした情報源

- [PlanetScale Postgres compatibility](https://planetscale.com/docs/postgres/postgres-compatibility) — PlanetScale PostgresがPostgreSQL 17・18をベースにしていることの確認
- [Postgres 18 is now available — PlanetScale](https://planetscale.com/blog/postgres-18-is-now-available)
- [Migrate from Supabase to PlanetScale - PlanetScale](https://planetscale.com/docs/postgres/imports/supabase) — #667の主要根拠。Direct connection必須・IPv4アドオン必須・シーケンスsetval・CREATE PUBLICATION/SUBSCRIPTION手順・カットオーバー手順
- [Database replication | Supabase Docs](https://supabase.com/docs/guides/database/replication) — Supabase側のwal_level=logicalデフォルト有効についての確認
- [TIL: Creating tables without primary keys CAN cause updates and deletes to fail in Postgres](https://www.abhinavomprakash.com/posts/replica-identities/) — replica identity/PK無しテーブルの挙動確認
- [ERROR: cannot delete from table because it does not have a replica identity and publishes deletes | PostgreSQL Error Reference](https://www.bytebase.com/reference/postgres/error/cannot-delete-from-table-no-replica-identity/) — 同上
- 社内既存ドキュメント: `docs/history/migration/DB_PHASE2_RUNBOOK.md`（#666）、`docs/db-driver-migration.md`（Phase 1）— 既存の推定値（関数数・トリガー数・シーケンス数）との突き合わせに使用

## 6. 追加調査（2026-07-19、#666ランブックのオーナー確認前の技術調査フェーズ）

本章は2026-07-10の初回監査（1〜5章）を踏まえ、`docs/history/migration/DB_PHASE2_RUNBOOK.md` 8章の残る未決定事項のうち、
技術調査で埋められる部分を追加で調べたもの。**実インフラの新規作成・実機でのCREATE ROLE/pg_restore
実行はいずれも行っていない**（PlanetScale上にDBを作成する行為自体はオーナー承認が必要な課金操作の
ため、本追加調査のスコープ外）。以下は全て公式ドキュメント調査・リポジトリ内grep調査に基づく。

### 6.1 PlanetScale PostgresのRLS/ロール機構（#665の残論点）

| 項目 | 判定 |
|---|---|
| RLS機能自体（`ENABLE ROW LEVEL SECURITY`/`CREATE POLICY`/`BYPASSRLS`） | Supabaseと完全に同一（標準PostgreSQLエンジンの機能そのもの。PlanetScale Postgresは同名の"Vitess"（MySQL互換）製品とは別実装で、PostgreSQL 17/18ベースのフル互換エンジン） |
| ロール作成・GRANT/REVOKE・ロール属性付与のメカニズム | Supabaseと完全に同一（標準SQL経由。デフォルト`postgres`ロールが`BYPASSRLS`/`CREATEROLE`を保有） |
| Supabase組み込みロール（`service_role`/`anon`/`authenticated`） | **非対応（PlanetScale側に存在しない）。移行時に手動で空ロールとして再現する必要あり** |
| `auth.jwt()`/`auth.role()`（JWTクレーム述語関数） | **非対応（存在しない）**。ただしtwicaのpg直結経路は元々PostgRESTを経由せず`twica_app`がBYPASSRLSでこの5テーブル（`storage_usage`/`blob_files`/`errors`/`support_codes`/`user_licenses`）のポリシーを迂回済みのため、機能的な差異は生じない見込み |
| `SECURITY DEFINER`関数 | Supabaseと完全に同一（PlanetScale公式ドキュメント自身が`pganalyze`セットアップ手順で使用） |
| 東京リージョン(`ap-northeast-1`)でのPostgres提供 | 提供あり（`postgresql_supported: true`、組織`tsubasa-azumagakito`のAPIで直接確認） |
| PS-5料金 | 単一ノード$5/月・HA(2レプリカ)$15/月（runbook1章の記載と一致） |
| ストレージ課金 | **「上限」ではなく従量課金**: 各クラスタに最初の10GBが込み、超過分は東京$0.150/GB/月（固定ストレージ上限という枠組みは存在しない。runbook1章の「PS-5の具体的なストレージ上限」という表現は「10GB込み+従量課金」に読み替える必要がある） |

**新規発見（実restore時の障害リスク、要runbook反映）**: `--no-privileges`はGRANT文（ACL）のみを
除外し、`CREATE POLICY ... TO service_role`のようなRLSポリシー定義自体（`pg_policy`カタログ、ACLでは
ない）は除外しない。grep実測で**34ファイル・78箇所**が`TO service_role`（一部`TO authenticated`/
`TO anon`）を含むポリシー/GRANT文を持つことを確認済み。PlanetScale側に`service_role`/`anon`/
`authenticated`ロールが事前に存在しないと、pg_restore実行時に`role "service_role" does not exist`
で失敗すると推定される（PostgreSQL標準仕様に基づく強い推論、**実機未検証**）。同様に、JWTクレーム
述語5テーブルの`CREATE POLICY ... USING (auth.jwt() ->> 'role' = ...)`は`auth.jwt()`関数が
カタログに存在しないと構文検証（式内の関数解決）で失敗する。

**対処案（5章手順への追加が必要）**: restore実行前に以下を投入する:
```sql
CREATE ROLE service_role NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'anon'::text $$;
```
（1章の監査で実際にDocker上で動作確認済みの構成と同一）。`realtime.messages`/`realtime.topic()`
（00034、`TO authenticated`/`TO anon`対象）はSupabase Realtimeのprivateチャンネル向けで、Phase 2は
`public`スキーマのみをdump対象にする方針（6.3節参照）のためそもそも移送対象にならない見込み。

### 6.2 #667 logical replicationの最終推奨（採用しない）

2026-07-10時点の4章の結論（技術的に採用可能）に、コストベネフィット判定を追加した。

- **Supabase側の追加コスト**: 外部レプリケーション先へのIPv4アドオンは**Freeプランでは利用不可**、
  Proプラン以上（$25/月〜）+アドオン$4/月が前提。twica現行プランは未確認だが、下位プランの場合は
  月$29程度の新規経常コストが移行のためだけに発生しうる。
- **PlanetScale側の権限**: 組織フラグ`pg_role_replication: "full"`（`planetscale_get_organization`で
  確認済み）は、2026-07-08付PlanetScale changelog「Postgresロールへの`REPLICATION`属性付与機能」の
  ロールアウト制御フラグと推定され、この組織では制限なく利用可能な状態。
- **削減できる停止時間に対してコスト不釣り合い**: 現行の数分停止方式は既に5〜10分程度の見積り
  （DB 0.334GBの小規模ゆえ）で、maintenance mode UX（503+Retry-After・書き込みボタン事前disable・
  EventSubのKV退避+自動リプレイ、#694/#787で実装済み）によりユーザー影響は既に十分小さい。
  レプリケーションラグ監視・tablesync状態管理・DDL変更の非同期化制約など運用複雑さの増加が、
  個人開発の運用体制（オンコール専任者なし）に見合わない。

**結論: 数分停止方式（pg_dump/restore）を正式採用とし、#667/#696（実環境リハーサル）は
このコスト構造の判断により実施しない、という提案。最終確定はオーナー判断（8章参照）。**

### 6.3 切替後のmigration適用手段（8章「未決定事項」の技術設計）

- **`supabase_migrations.schema_migrations`（Supabase CLIの適用履歴テーブル）は移送しない方針を推奨**。
  理由: (1) `pg_dump`にスキーマ指定（`-n`）が無いと`public`以外の全非システムスキーマ
  （`auth`/`storage`/`supabase_migrations`等）が対象になり、`twica_app`が権限を持たないテーブルに
  遭遇した時点でpg_dump**全体が失敗する**（部分スキップではない、PostgreSQL標準仕様）。
  (2) 移送できたとしても新ツールがそのテーブル形式を理解する保証がない。
  → **5章のpg_dumpコマンドに`-n public`を追加し、スコープを明示すべき**（現状のコマンドはこの
  リスクを内包している。5章への反映が必要）。
- **推奨する新規適用手段**: Node.jsカスタムスクリプト（`scripts/verify-db-schema.js`/
  `scripts/check-migration-order.js`と同じパターン、`postgres`パッケージ・`DATABASE_URL`環境変数
  経由）。`sql.begin()`によるファイル単位トランザクションで、既知の`SET LOCAL statement_timeout`
  問題（3.1節、`00051_add_card_owner_stats.sql`。`psql -f`はデフォルトでファイル全体を1トランザクション
  にラップしないためこの問題が起こりうる）を自然に回避できる。Flyway等の確立ツールも検討したが、
  既存71ファイルの命名規則変更が必須になり導入コストが見合わないため見送り。
- **カットオーバー時の履歴初期化**: 新規履歴テーブルを、pg_restore完了直後に「その時点で存在する
  全migrationファイルを適用済みとして一括登録するbootstrapモード」で初期化する（実SQLは実行しない、
  Supabase CLIの`migration repair --status applied`と同じ発想）。
- **CI（`.github/workflows/deploy-cloudflare.yml`）への組み込み**: 新規環境変数`MIGRATION_TARGET`
  （`supabase`|`planetscale`、未設定時は安全側`supabase`にフォールバック）でステップ内分岐する
  設計を推奨。ジョブの`if:`ではなくステップ内条件にするのは、environment-scoped変数がジョブの
  `environment:`解決後でないと使えないため。preview環境だけ先に`planetscale`へ切り替えてリハーサル→
  本番切替時にproduction環境も切り替える、という段階ロールアウトがコード変更なしで可能になる。

未実装（別途スクリプト実装・レビュー・CI変更のPRが必要、本追加調査のスコープ外）。

## 付記: 検証手順の再現方法

```bash
# 1. コンテナ起動（ポート5433、ホストの5432と衝突しないことを事前にdocker psで確認）
docker run -d --name twica-pg-audit -e POSTGRES_PASSWORD=audit -p 5433:5432 postgres:17

# 2. 拡張確認
docker exec -e PGPASSWORD=audit twica-pg-audit \
  psql -h localhost -U postgres -d postgres -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'

# 3. migrationファイルをコンテナにコピーし、DB作成 + Supabase互換スタブ投入（2.3節参照）
docker cp supabase/migrations/. twica-pg-audit:/migrations/
# auditfinal DBを作成し、auth/realtimeスキーマ・anon/authenticated/service_roleロールを
# ダミー実装した上で、/migrations/*.sql をファイル名順に psql -f -v ON_ERROR_STOP=1 で適用

# 4. 検証クエリ（2.4・2.5節の各クエリ）を auditfinal DB に対して実行

# 5. 後片付け（本監査の完了後に実施済み）
docker rm -f twica-pg-audit
```
