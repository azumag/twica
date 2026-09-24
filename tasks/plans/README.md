# `tasks/plans` の読み方

このディレクトリの設計書には、機能設計時点の判断記録が含まれます。未完了機能を実装するときは、当時の設計意図と現在のruntime契約を分けて扱ってください。

## DB / runtime 接続方式の正本

DBとruntimeの接続方式については、[`docs/db-driver-migration.md`](../../docs/db-driver-migration.md) を現在の正本とします。

現行のroot app runtimeは PlanetScale PostgreSQL 固定です。移行期に使われた PostgREST、`getSupabaseAdmin`、`DB_DRIVER` 等のdriver切替、Supabase runtime credential は現行runtimeのロールバック先ではありません。設計書にこれらの記述が残っていても、そのまま新しいruntime実装へ復活させないでください。

一方で、設計書に記録されたDB不変条件、原子性、冪等性、所有権、権限境界、履歴保持などの要件まで機械的に捨てるものではありません。migration履歴も、現在のschema正本と照合せずに削除・置換しないでください。

個別機能で旧接続方式に依存したAPI・transaction・retry・notification transport等の再設計が必要な場合は、そのIssueで現在のアーキテクチャへ再ベースラインしてから実装します。このREADME自体は個別機能の挙動や互換性を決定しません。

## 現在進行中の個別override

### #632 Live Directory

#632 / #737 / #738 / #739 / #740 と `issue-632-live-directory.md` には、設計時点の Supabase service_role / direct PostgREST / RPC / Supabase Realtime をDB runtimeとして使う前提が残っています。これらは履歴として参照し、現在の PlanetScale PostgreSQL 固定runtimeへそのまま復活させません。

- DB読み書き・集計は現行のDB helper / service境界へ再設計し、旧direct PostgREST、service_role DB runtime、`DB_DRIVER` 分岐を新規追加しません。
- `supabase/migrations` は `docs/db-driver-migration.md` で定義されたmigration historyの入力として現在も扱うため、旧runtime前提と混同して機械的に削除・移動しません。
- `last_seen` 更新、集計の冪等性、privacy / authorization境界、ランキング・統計の分離、性能目標と観測性などの機能要件は、現行runtimeへ再マップして維持します。
- Realtime transportは現在のCloudflare / PlanetScale構成で別途設計し、旧Supabase Realtime案だけを根拠に自動復活させません。

このoverrideは接続方式の読み替えだけを定義し、Live Directoryのproduct仕様やRealtime transport方式、Preview実経路QAの完了を決定しません。

### #642 統計ランキング

#642 / #741 / #742 には設計時点の PostgREST / `DB_DRIVER` / dual-driver / Supabase role 前提が残っています。これらは履歴として参照し、現在の PlanetScale PostgreSQL 固定runtimeへそのまま復活させません。

- 集計・読み取りの実装経路は現行 PlanetScale + Hyperdrive / postgres.js + Drizzle のDB helperへ再設計します。旧 `.rpc()` / PostgREST 分岐や dual-driver parity を新規追加しません。
- 一方、JST日境界での冪等集計、snapshotの原子的置換、backfill完了前の公開抑止、他streamer識別子をクライアントへ出さない匿名化境界などの安全要件は維持します。
- #642 に残るカード登録数ランキングの表示方式、将来opt-out、全期間統計方針の更新は product / privacy 判断を伴うため、このruntime読み替えだけで決定しません。

#741 / #742 の最新Issue本文・状態同期コメントを current-runtime の実装境界として扱い、特に #741 は本文の旧設計より 2026-09-24 の状態同期コメントを優先してください。旧接続方式の記述だけを根拠にコードや権限モデルを復活させないでください。

### #715 カードトレード

`issue-715-card-trading.md` には設計時点の Supabase / PostgREST / dual-driver 前提や、rate limit KV が未配線だった時点の記録が残っています。これらは履歴として参照し、現在のruntimeへそのまま復活させません。

- DB基盤は #722 で現行 PlanetScale PostgreSQL migration / schema へ実装済みです。API・settings実装では #723 / #724 / #725 の最新Issue本文を現在の接続・retry境界として扱います。
- `RATE_LIMIT_KV` のコード配線は #728 の lazy auto-init 方式で実装済みです。設計書に残る「未配線なので常にMemory」という前提は採用しません。一方、Workers KV の same-key write制限、eventual consistency、非原子的RMW、fail-openを踏まえた strict backend 方針と実環境観測は #728 の未完了条件です。
- 成立通知は #729 の最新状態を正とし、旧Supabase Realtime案を復活させず、現行Cloudflare / PlanetScale transportから再設計します。

カードトレード設計にある原子性、冪等性、所有権、履歴保持、設定ゲート等の機能要件まで無効化するものではありません。

### #720 コンプ報酬

#720 / #731 には実装前の Supabase migration / PostgREST / dual-driver 前提が設計履歴として残っています。現在のコンプ報酬DB実装の正本は `db/planetscale/migrations/20260907000000_add_pack_completion_rewards.sql` と現行 PlanetScale / Hyperdrive のAPI・service実装です。旧接続方式を新しいruntime実装へ復活させません。

- #731 / #733 / #734 はコード実装済みで、現在は対象Preview DB、375px実画面、設定→取得→reload等の外部実経路ゲートを追跡しています。同じDB/API/UIを別PRで再実装しません。
- 実装内容を確認するときは、現行migration・`src/lib/services/pack-completion-reward.ts`・`src/app/api/streamer/pack-completion-rewards/route.ts` と対応testを正とします。
- 冪等付与、報酬カードをinactiveに保つ不変条件、アクティブ化とのTOCTOU防止、未コンプ時のカード情報秘匿、migration未適用windowで既存画面を壊さない契約は引き続き維持します。

Preview実経路の未取得項目をローカル/CI結果で完了扱いにせず、実環境証跡を捏造しません。
