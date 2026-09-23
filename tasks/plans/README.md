# `tasks/plans` の読み方

このディレクトリの設計書には、機能設計時点の判断記録が含まれます。未完了機能を実装するときは、当時の設計意図と現在のruntime契約を分けて扱ってください。

## DB / runtime 接続方式の正本

DBとruntimeの接続方式については、[`docs/db-driver-migration.md`](../../docs/db-driver-migration.md) を現在の正本とします。

現行のroot app runtimeは PlanetScale PostgreSQL 固定です。移行期に使われた PostgREST、`getSupabaseAdmin`、`DB_DRIVER` 等のdriver切替、Supabase runtime credential は現行runtimeのロールバック先ではありません。設計書にこれらの記述が残っていても、そのまま新しいruntime実装へ復活させないでください。

一方で、設計書に記録されたDB不変条件、原子性、冪等性、所有権、権限境界、履歴保持などの要件まで機械的に捨てるものではありません。migration履歴も、現在のschema正本と照合せずに削除・置換しないでください。

個別機能で旧接続方式に依存したAPI・transaction・retry・notification transport等の再設計が必要な場合は、そのIssueで現在のアーキテクチャへ再ベースラインしてから実装します。このREADME自体は個別機能の挙動や互換性を決定しません。
