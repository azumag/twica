# `tasks/plans` の読み方

このディレクトリの設計書には、機能設計時点の判断記録が含まれます。未完了機能を実装するときは、当時の設計意図と現在のruntime契約を分けて扱ってください。

## DB / runtime 接続方式の正本

DBとruntimeの接続方式については、[`docs/db-driver-migration.md`](../../docs/db-driver-migration.md) を現在の正本とします。

現行のroot app runtimeは PlanetScale PostgreSQL 固定です。移行期に使われた PostgREST、`getSupabaseAdmin`、`DB_DRIVER` 等のdriver切替、Supabase runtime credential は現行runtimeのロールバック先ではありません。設計書にこれらの記述が残っていても、そのまま新しいruntime実装へ復活させないでください。

一方で、設計書に記録されたDB不変条件、原子性、冪等性、所有権、権限境界、履歴保持などの要件まで機械的に捨てるものではありません。migration履歴も、現在のschema正本と照合せずに削除・置換しないでください。

個別機能で旧接続方式に依存したAPI・transaction・retry・notification transport等の再設計が必要な場合は、そのIssueで現在のアーキテクチャへ再ベースラインしてから実装します。このREADME自体は個別機能の挙動や互換性を決定しません。

## 現在進行中の個別override

### #715 カードトレード

`issue-715-card-trading.md` には設計時点の Supabase / PostgREST / dual-driver 前提や、rate limit KV が未配線だった時点の記録が残っています。これらは履歴として参照し、現在のruntimeへそのまま復活させません。

- DB基盤は #722 で現行 PlanetScale PostgreSQL migration / schema へ実装済みです。API・settings実装では #723 / #724 / #725 の最新Issue本文を現在の接続・retry境界として扱います。
- `RATE_LIMIT_KV` のコード配線は #728 の lazy auto-init 方式で実装済みです。設計書に残る「未配線なので常にMemory」という前提は採用しません。一方、Workers KV の same-key write制限、eventual consistency、非原子的RMW、fail-openを踏まえた strict backend 方針と実環境観測は #728 の未完了条件です。
- 成立通知は #729 の最新状態を正とし、旧Supabase Realtime案を復活させず、現行Cloudflare / PlanetScale transportから再設計します。

カードトレード設計にある原子性、冪等性、所有権、履歴保持、設定ゲート等の機能要件まで無効化するものではありません。
