/**
 * Maintenance mode: クライアント側共有ヘルパー (#694 Stage 6a)
 *
 * UI側（コンポーネント）が maintenance 状態を検出・表示するための基盤の一部。
 * このファイル自体はまだどこからも使われない（Stage 6a は基盤の追加のみ。
 * 既存コンポーネントへの組み込みは Stage 6b/6c で行う）。
 *
 * 'use client' を付けない理由:
 * このファイルは fetch() / Date.parse() / JSON のパースのみに依存する
 * 副作用のない（fetchMaintenanceStatus 以外は）純粋なユーティリティ関数の
 * 集合であり、Reactフックやbrowser専用APIを一切使わない。src/lib/csrf.ts や
 * src/lib/rate-limit.ts と同じ方針で、サーバー（API route）・クライアント
 * （コンポーネント）の両方から素の TS モジュールとして import できる。
 * Stage 6b でクライアントコンポーネントから使う場合は、呼び出し元の
 * コンポーネント自身に 'use client' を付ければ十分であり、このモジュールに
 * 付ける必要はない（付けると逆にサーバー側 route.ts から import する際に
 * 意味のない境界を作ってしまう）。
 */
import { MAINTENANCE_ERROR_CODE_BY_MODE, type MaintenanceErrorCode, type MaintenanceMode } from './state'

/**
 * GET /api/maintenance-status のレスポンス形状。
 *
 * getMaintenanceState() の全フィールドのうち、機密情報（内部運用情報）を
 * 除いたものだけを公開する。issue #694 の「public status endpoint に
 * 機密情報を出さない」という要求に従い、以下は意図的に含めない:
 *   - operationId: インシデント対応時の内部相関ID。外部に見せる情報ではない。
 *   - startedAt: 開始時刻。攻撃者に運用パターン（メンテ頻度・所要時間の推測材料）
 *     を与えうるため、UIが必要とする「いつ終わるか」(expectedEndAt) だけを出す。
 */
export interface MaintenanceStatusResponse {
  mode: MaintenanceMode
  expectedEndAt?: string
  /**
   * 告知文言の出し分けキー（例: 'planned' | 'incident'）。state.ts の
   * MaintenanceState.publicMessageKey をそのまま透過する（自由形式の文字列で、
   * このモジュールは値の妥当性を検証しない）。
   *
   * Stage 6b 実装者向けの解決規約（このStageでは未実装。ここに明記して
   * おくことで、6bで独自ルールを再発明したり、messages/ja.json の
   * `maintenance.modes.*` と `maintenance.messageKeys.*` のどちらを
   * 優先すべきか毎回悩む事故を防ぐ）:
   *   1. publicMessageKey が設定されていて、かつ
   *      `messages.maintenance.messageKeys[publicMessageKey]` が存在するなら
   *      それを使う（運用者が意図した具体的な告知文言を優先）。
   *   2. 上記が使えない場合（publicMessageKey 未設定 or 対応するキーが
   *      辞書に無い）は `messages.maintenance.modes.*` の mode 別
   *      デフォルト文言にフォールバックする（guard.ts の DEFAULT_MESSAGES と
   *      同じ「常に意味の通る文言を出す」フォールバック方針）。mode 値
   *      （'read-only' 等のkebab-case）とJSONキー（'readOnly' 等の
   *      camelCase）は綴りが異なるため、6bの解決ロジックは変換が必要。
   */
  publicMessageKey?: string
}

/**
 * state.ts の MAINTENANCE_ERROR_CODE_BY_MODE と1対1対応する
 * machine-readable エラーコード（guard.ts が 503 body の error.code として
 * 返す値そのもの）。'off' は拒否されないため（guardWrite が null を返す）
 * ここには存在しない。
 *
 * state.ts から re-export する理由: guard.ts（生成側）と このモジュール
 * （判定側）が同じ3値を別々に書き写すと、将来 mode を追加した際に片方だけ
 * 更新されて判定漏れが起きるリスクがある。単一の実装元（state.ts）を
 * 両側から参照する形に統一している。
 */
export type { MaintenanceErrorCode }

const MAINTENANCE_ERROR_CODES: readonly MaintenanceErrorCode[] = Object.values(
  MAINTENANCE_ERROR_CODE_BY_MODE
) as MaintenanceErrorCode[]

function isMaintenanceErrorCode(value: unknown): value is MaintenanceErrorCode {
  return (
    typeof value === 'string' &&
    (MAINTENANCE_ERROR_CODES as readonly string[]).includes(value)
  )
}

/** guardWrite() が返す 503 レスポンスの body から抽出した情報。 */
export interface MaintenanceErrorInfo {
  code: MaintenanceErrorCode
  message: string
  retryable: boolean
  expectedEndAt?: string
}

/**
 * fetch レスポンスとその JSON body から maintenance エラー情報を判定・抽出する純関数。
 *
 * body を引数で受け取る設計にした理由:
 * Response.body は一度しか読めないストリームであるため、この関数自身が
 * response.json() を呼んでしまうと、呼び出し元が既にエラーハンドリングの
 * どこかで body を読んでいた場合に "body stream already read" で例外になる。
 * 呼び出し元が「自分でパースした（または失敗した）結果」をそのまま渡せるように
 * することで、この関数を fetch/JSON パースの成否に関わらず安全に呼べる
 * 純粋関数（副作用ゼロ）に保っている。
 *
 * 判定基準（issue #694 のレスポンス仕様に対応）:
 *   1. response.status が 503 でなければ null（maintenance 拒否は必ず 503）。
 *   2. body が `{ error: { code, message, retryable, expectedEndAt? } }` の
 *      形を満たさなければ null。
 *   3. code が maintenance 系3種のいずれでもなければ null（他の 503 理由
 *      ——例えば通常のサービス過負荷等——と混同しないため）。
 *
 * @param response fetch() の Response
 * @param body 呼び出し元が既にパース済みの JSON body（省略時は判定不能で null）
 */
export function parseMaintenanceError(
  response: Response,
  body?: unknown
): MaintenanceErrorInfo | null {
  if (response.status !== 503) {
    return null
  }
  if (typeof body !== 'object' || body === null) {
    return null
  }

  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) {
    return null
  }

  const { code, message, retryable, expectedEndAt } = error as Record<string, unknown>
  if (!isMaintenanceErrorCode(code) || typeof message !== 'string') {
    return null
  }

  return {
    code,
    message,
    // guardWrite は常に retryable: true を返す設計（guard.ts 参照）。ここでは
    // 不正な body（retryable が boolean でない等）に対しても例外を投げず、
    // 安全側の false に倒す（「再試行してよい」という誤った情報をUIに渡さない）。
    retryable: retryable === true,
    ...(typeof expectedEndAt === 'string' ? { expectedEndAt } : {}),
  }
}

/**
 * 'off' 以外の3モードは MAINTENANCE_ERROR_CODE_BY_MODE のキーから導出する
 * （手書きの配列にしない）。理由: state.ts の型定義（MaintenanceMode）・
 * MAINTENANCE_ERROR_CODE_BY_MODE・この KNOWN_MODES の3箇所すべてで
 * モード一覧を独立して書き写すと、将来 mode を追加した際にこの配列だけ
 * 更新し忘れても TypeScript の型チェックは通ってしまう（readonly
 * MaintenanceMode[] は「部分集合の配列」も許容するため）。その場合
 * fetchMaintenanceStatus() が新モードを黙って 'off' に丸めてしまう
 * silent failure になる。MAINTENANCE_ERROR_CODE_BY_MODE の更新を怠ると
 * guard.ts 側の 503 応答コードも生成できず気づきやすい一方、この配列は
 * 見た目上動く（コンパイルも通る）ため気づきにくい——単なる手書きの重複より
 * 実害が大きい種類のドリフトなので、値ではなくキー由来で導出して物理的に
 * 同期させている。
 * Object.keys() の戻り値型は TypeScript 上常に string[] になる仕様
 * （超過プロパティを持つ構造的部分型を許容するため）なので、
 * Exclude<MaintenanceMode, 'off'>[] へのキャストが必要になる。とはいえ
 * MAINTENANCE_ERROR_CODE_BY_MODE のキー自体は `satisfies` で
 * Exclude<MaintenanceMode, 'off'> と一致することが既に型チェック済みなので、
 * このキャストは「型を偽っている」わけではない。
 */
const KNOWN_MODES: readonly MaintenanceMode[] = [
  'off',
  ...(Object.keys(MAINTENANCE_ERROR_CODE_BY_MODE) as Exclude<MaintenanceMode, 'off'>[]),
]

function isMaintenanceMode(value: unknown): value is MaintenanceMode {
  return typeof value === 'string' && (KNOWN_MODES as readonly string[]).includes(value)
}

/**
 * GET /api/maintenance-status の薄いクライアント。
 *
 * fail-safe なデフォルト（mode: 'off'）を返す設計にした理由:
 * このヘルパーは「maintenance 状態を UI に反映する」ためのものであり、
 * ネットワーク障害・非 200 応答・不正な JSON 等いかなる失敗時にも例外を
 * 投げない。呼び出し元（Stage 6b のバナー等）に try/catch を強制せず、
 * 失敗時は「メンテナンス中ではない」という通常運用時と同じ安全側の状態に
 * フォールバックする。これは issue #694 の「mode=off 時に挙動不変」という
 * 要件と一貫しており、status 取得自体が失敗した場合も通常時と同じ
 * 「何も表示しない」挙動になる（実際に mode=read-only 中に取得が失敗した
 * 場合はバナーが一時的に消えるが、書き込み自体は guardWrite が別途
 * ブロックし続けるため、安全性はそちらで担保されている）。
 */
export async function fetchMaintenanceStatus(): Promise<MaintenanceStatusResponse> {
  try {
    // メンテ解除後に古い status がキャッシュされないよう no-store を明示する
    // （サーバー側の Cache-Control: private, no-store と対になる指定）。
    const response = await fetch('/api/maintenance-status', { cache: 'no-store' })
    if (!response.ok) {
      return { mode: 'off' }
    }

    const data = (await response.json()) as Record<string, unknown>
    const mode = isMaintenanceMode(data.mode) ? data.mode : 'off'
    const expectedEndAt = typeof data.expectedEndAt === 'string' ? data.expectedEndAt : undefined
    const publicMessageKey =
      typeof data.publicMessageKey === 'string' ? data.publicMessageKey : undefined

    return {
      mode,
      ...(expectedEndAt ? { expectedEndAt } : {}),
      ...(publicMessageKey ? { publicMessageKey } : {}),
    }
  } catch {
    // fetch 自体の失敗（オフライン等）・response.json() のパース失敗の両方をここで拾う。
    return { mode: 'off' }
  }
}

/**
 * Retry-After ヘッダー（秒、文字列）と expectedEndAt（ISO 8601 文字列）から、
 * 「次に再試行してよい時刻」を1つの Date へ正規化するヘルパー（Stage 6b で
 * バナーの表示に使う想定）。
 *
 * ロケール依存の文字列整形（「あと5分」「16:32に再試行可能」等）はこの関数の
 * スコープに含めない。理由: このモジュールはサーバー/クライアント両用の
 * 薄いユーティリティという設計意図であり、next-intl の useFormatter 等
 * React コンポーネント文脈でしか使えない整形手段に依存させたくない。
 * Date を返すところまでをこの純関数の責務とし、実際の文言整形は Stage 6b の
 * バナーコンポーネント側（useFormatter 等）に委ねる。
 *
 * 優先順位: expectedEndAt が未来の妥当な時刻ならそれを優先する。
 * 理由: guard.ts の computeRetryAfterSeconds は expectedEndAt が
 * 未設定/不正/過去日時のときに一律 RETRY_AFTER_FALLBACK_SECONDS（300秒）へ
 * 倒すため、Retry-After ヘッダーだけを見ると常に「実際の想定終了時刻」より
 * 粗い「とりあえず5分後」という目安になりがちである。expectedEndAt は
 * サーバーが把握する実際の想定終了時刻でより正確なので、使える場合はそちらを
 * 優先し、expectedEndAt が使えない場合だけ Retry-After（相対秒数）に
 * フォールバックする。
 *
 * @param input.retryAfterHeader Retry-After レスポンスヘッダーの値（秒数の文字列を想定。
 *   自社サーバー（guard.ts）が返す形式のみサポートすればよく、HTTP仕様が許容する
 *   HTTP-date形式までは対応しない — YAGNI）。
 * @param input.expectedEndAt ISO 8601 の想定終了時刻文字列。
 * @param now 比較基準時刻（epoch ms）。テスト容易性のため引数化（省略時は Date.now()）。
 */
export function resolveRetryAt(
  input: { retryAfterHeader?: string | null; expectedEndAt?: string },
  now: number = Date.now()
): Date | null {
  if (input.expectedEndAt) {
    const endMs = Date.parse(input.expectedEndAt)
    if (!Number.isNaN(endMs) && endMs > now) {
      return new Date(endMs)
    }
  }

  if (input.retryAfterHeader) {
    const seconds = Number(input.retryAfterHeader)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return new Date(now + seconds * 1000)
    }
  }

  return null
}
