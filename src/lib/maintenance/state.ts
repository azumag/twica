/**
 * Maintenance mode 状態解決 (#694 Stage 1)
 *
 * サービス全体のメンテナンス状態を表す。issue #694 で確定した状態モデル:
 *   - 'off'                 : 通常運用
 *   - 'read-only'           : 計画メンテナンス。一般 write を拒否し EventSub は queue へ退避
 *   - 'cutover-validating'  : DB target 切替後、write 解禁前の検証状態
 *   - 'incident-read-only'  : 障害対応。告知文言・Retry-After を計画停止と分けられる
 *
 * この state.ts はまだどこからも参照されない（Stage 1+2 は純粋な追加のみ）。
 * 実際に write route から呼ばれるのは Stage 3 の guard 実装から。
 */
export type MaintenanceMode =
  | 'off'
  | 'read-only'
  | 'cutover-validating'
  | 'incident-read-only'

/**
 * mode ⇔ machine-readable エラーコードの1:1対応（Stage 3 guard.ts が 503 body
 * の `error.code` として返し、Stage 6a client.ts が UI 側でその判定に使う）。
 * 'off' は拒否されない（guardWrite が null を返す）ため対象外。
 *
 * 単一の実装元をここに置く理由: この対応は guard.ts（サーバー: エラー生成）と
 * client.ts（クライアント: エラー判定）の両方から参照される「ワイヤーフォーマット
 * の契約」そのもの。以前は両ファイルがそれぞれ独立してこの3値を書き写しており、
 * 将来 mode を追加した際に片方だけ更新してもう片方が黙って古いままになる
 * （＝新しい mode のエラーを client 側が判定できなくなる）ドリフトの実例的リスクが
 * あったため、state.ts（両者が既に import している MaintenanceMode の定義元）に
 * 集約した。
 */
/**
 * `as const satisfies Record<...>` を組み合わせる理由（型レベルのドリフト防止）:
 * 単に `: Record<Exclude<MaintenanceMode, 'off'>, string>` という型注釈だけを
 * 付けると、値の型がその注釈でワイドニングされてしまい、各プロパティ値は
 * リテラル型ではなく単なる `string` になる。その結果、下の
 * `MaintenanceErrorCode`（indexed access で導出）も実質 `string` になり、
 * 「maintenance系3値のいずれか」を強制するはずの型が何の文字列でも代入できて
 * しまう（コメントで謳っているドリフト防止が型レベルでは機能しない）。
 * `as const` で値をリテラル型のまま固定しつつ、`satisfies` でキーが
 * `Exclude<MaintenanceMode, 'off'>` を過不足なく網羅していることを型チェック
 * 時に強制する（`satisfies` は `as const` のリテラル型を保ったまま形状だけ
 * 検証するため、`:` 注釈と違って値の型を犠牲にしない）。
 */
export const MAINTENANCE_ERROR_CODE_BY_MODE = {
  'read-only': 'maintenance_read_only',
  'cutover-validating': 'maintenance_cutover_validating',
  'incident-read-only': 'maintenance_incident_read_only',
} as const satisfies Record<Exclude<MaintenanceMode, 'off'>, string>

/**
 * MAINTENANCE_ERROR_CODE_BY_MODE の値から導出する、取りうるエラーコードの
 * リテラル合併型（'maintenance_read_only' | 'maintenance_cutover_validating' |
 * 'maintenance_incident_read_only'）。上記の `as const` により、ここは単なる
 * `string` ではなく実際のリテラル合併型になる。
 */
export type MaintenanceErrorCode =
  (typeof MAINTENANCE_ERROR_CODE_BY_MODE)[keyof typeof MAINTENANCE_ERROR_CODE_BY_MODE]

/**
 * issue #694 で定義された state の shape。
 * startedAt / expectedEndAt は ISO 8601 文字列を想定するが、値の妥当性は
 * getMaintenanceState() 側で検証済み（不正なら undefined になっている）。
 */
export interface MaintenanceState {
  mode: MaintenanceMode
  startedAt?: string
  expectedEndAt?: string
  /**
   * 告知文言の出し分けキー（自由形式の文字列。フォーマットは未規定）。
   * Stage 6a で messages/ja.json・messages/en.json に追加した
   * `maintenance.messageKeys.<key>`（例: 'planned' | 'incident'）と対応させる
   * 運用を想定しているが、この型自体はその規約を強制しない（運用側が
   * 未対応のキーを設定した場合の扱いは、UI側（Stage 6b）の解決ロジックが
   * `maintenance.modes.*` の mode別デフォルト文言へフォールバックする形で
   * 吸収する想定。src/lib/maintenance/client.ts の MaintenanceStatusResponse
   * のドキュメントコメント参照）。
   */
  publicMessageKey?: string
  operationId?: string
}

/**
 * 時刻を表す環境変数値を検証する。
 *
 * Date.parse は不正なフォーマットに対して例外を投げず NaN を返す仕様なので、
 * try/catch は不要（意図的に使わない）。呼び出し元（guard の Retry-After 計算等）
 * が「値が無い」ケースとして安全に扱えるよう、パースできない値は必ず undefined を返す
 * ——絶対に throw しない。
 *
 * 値自体（生の文字列）を返す理由: 呼び出し側は Date オブジェクトではなく
 * MaintenanceState.expectedEndAt という ISO 文字列を JSON レスポンスへそのまま
 * 埋め込みたいため、正規化はせず「妥当な時刻文字列だったか」だけを判定する。
 */
function parseTimestampEnv(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) {
    return undefined
  }
  return Number.isNaN(Date.parse(trimmed)) ? undefined : trimmed
}

/**
 * 現在の maintenance state を返す。
 *
 * 重要: process.env.MAINTENANCE_* は「呼び出しのたびに」読む。モジュールトップの
 * const にキャッシュしてはならない。OpenNext (Cloudflare Workers) は環境変数を
 * populateProcessEnv でランタイムに注入するため、モジュール評価時点では env が
 * まだ確定していないことがある（src/lib/db/flags.ts の getDbDriverMode と同じ理由。
 * 評価時に読むと常に未設定 = 'off' に固定されてしまい、切替が効かない）。
 *
 * 不正な MAINTENANCE_MODE は 'off' へフォールバックする。issue #694 の決定に従い、
 * 誤設定（typo等）でサービス全体を止める方向（例えば最も制限の強い
 * 'incident-read-only' 側に倒す）ではなく、通常運用が継続する安全側を選んでいる。
 * production 環境でのデプロイ前検証は Stage 7 で runbook / デプロイスクリプトに
 * 組み込む（このモジュール単体では validation を強制しない）。
 *
 * trim する理由: db/flags.ts と同じく、Cloudflare ダッシュボード / wrangler secret put
 * 経由の設定は改行・空白が混入しうる。trim しないと 'read-only\n' が不正値扱いになり
 * 意図したモード切替が黙って効かない。
 *
 * 同期関数である理由: 意図的に同期シグネチャとする。issue #694 タスク1が将来要件
 * として挙げている KV/DO からの動的切替に移行する場合は非同期化が必要になるが、
 * 案B（middleware 一律 + allowlist）採用により呼び出し箇所は middleware と
 * ごく少数の特殊 route（guardWriteRedirect を使う OAuth callback 等）に限られる
 * ため、その時点での非同期化コストは小さい。env を直読みするだけの現段階で
 * 将来の拡張に備えて先回りして非同期化するのは YAGNI に反するため行わない。
 */
export function getMaintenanceState(): MaintenanceState {
  const rawMode = process.env.MAINTENANCE_MODE?.trim()
  const mode: MaintenanceMode =
    rawMode === 'read-only' ||
    rawMode === 'cutover-validating' ||
    rawMode === 'incident-read-only'
      ? rawMode
      : 'off'

  const startedAt = parseTimestampEnv(process.env.MAINTENANCE_STARTED_AT)
  const expectedEndAt = parseTimestampEnv(process.env.MAINTENANCE_EXPECTED_END_AT)

  // publicMessageKey / operationId は自由形式の文字列。空文字（未設定 or 空白のみ）は
  // 「値なし」として undefined に正規化する（JSON レスポンスに空文字が漏れ出さないように）。
  const publicMessageKey = process.env.MAINTENANCE_MESSAGE_KEY?.trim() || undefined
  const operationId = process.env.MAINTENANCE_OPERATION_ID?.trim() || undefined

  return { mode, startedAt, expectedEndAt, publicMessageKey, operationId }
}
