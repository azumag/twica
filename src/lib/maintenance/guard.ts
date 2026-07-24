/**
 * Maintenance mode write guard (#694 Stage 2)
 *
 * 書き込み系 route の先頭で呼び、maintenance state に応じてリクエストを拒否する
 * 純粋関数群。DB 接続を作る前に呼べるよう、getMaintenanceState() 以外の
 * 非同期処理・外部 I/O は行わない（issue #694 の「rejected request で DB
 * connection を作らない」という受け入れ条件に対応するための設計）。
 *
 * このファイルはまだどこからも参照されない（Stage 1+2 は純粋な追加のみ）。
 * 実際に route / middleware から呼ばれるのは Stage 3 から。
 */
import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger.server'
import {
  getMaintenanceState,
  MAINTENANCE_ERROR_CODE_BY_MODE,
  type MaintenanceMode,
  type MaintenanceState,
} from './state'

/** expectedEndAt が未設定・過去日時のときに使う Retry-After のフォールバック秒数。 */
const RETRY_AFTER_FALLBACK_SECONDS = 300

/**
 * mode 別のデフォルト日本語メッセージ（サーバー側の静的文言）。
 *
 * publicMessageKey はクライアント側で辞書引き（i18n）するためのキーとして
 * レスポンスに含めるが、サーバー側では messages/ja.json 等の辞書引きをしない
 * （設計方針: シンプルに保つ）。そのためここに置くのは「辞書が引けない・
 * publicMessageKey が未設定な場合でも意味が通るデフォルト文言」であり、
 * 状態ごとに利用者が取るべき行動の含意が異なる（計画停止か障害かで再試行の
 * 心構えが変わる）ため、3種類の mode をまとめて1文にせず個別に持つ。
 *
 * Stage 6a 追記: messages/ja.json の `maintenance.modes.*` は意図的にこれと
 * 同じ文言を持つ（UI バナー側のデフォルト表示用）。この JSON API の body と
 * UI 表示は経路が異なる（前者は常に日本語固定、後者は next-intl でロケール
 * 追従）ため文言の実装元は意図的に分離しているが、日本語ワーディング自体は
 * 一致させておくこと（どちらか片方だけ文言を変えると、同じ状況で見た目の
 * 案内文が食い違うユーザー体験になる）。
 */
const DEFAULT_MESSAGES: Record<Exclude<MaintenanceMode, 'off'>, string> = {
  'read-only': 'ただいまメンテナンス中です。しばらくしてから再度お試しください。',
  'cutover-validating':
    'ただいまシステム移行の検証中です。しばらくしてから再度お試しください。',
  'incident-read-only':
    'ただいま障害対応のため書き込みを制限しています。しばらくしてから再度お試しください。',
}

/**
 * expectedEndAt から Retry-After（秒）を算出する。
 * 未設定・パース不能・過去日時（= 負値になるケース）は全てフォールバック秒数に倒す。
 * 負の Retry-After はクライアントにとって無意味かつ HTTP 的に不正なため、
 * 「出さない」という要件を満たすには算出結果ではなく必ずフォールバック値を返す。
 */
function computeRetryAfterSeconds(expectedEndAt: string | undefined): number {
  if (!expectedEndAt) {
    return RETRY_AFTER_FALLBACK_SECONDS
  }
  // state.ts 側で既に Date.parse 検証済みの値だが、guard 単体のテスト容易性と
  // 将来 state.ts の実装が変わった場合の防御のため、ここでも NaN を再確認する。
  const endMs = Date.parse(expectedEndAt)
  if (Number.isNaN(endMs)) {
    return RETRY_AFTER_FALLBACK_SECONDS
  }
  const remainingSeconds = Math.ceil((endMs - Date.now()) / 1000)
  return remainingSeconds > 0 ? remainingSeconds : RETRY_AFTER_FALLBACK_SECONDS
}

interface GuardRejection {
  state: MaintenanceState
  code: string
  message: string
}

/**
 * 現在の maintenance state を元に「拒否すべきか」を判定する共通ロジック。
 * guardWrite / guardWriteRedirect の両方から使う（レスポンス形式だけが異なる）。
 */
function evaluateGuard(allowDuring?: MaintenanceMode[]): GuardRejection | null {
  const state = getMaintenanceState()
  const { mode } = state
  if (mode === 'off' || allowDuring?.includes(mode)) {
    return null
  }

  return {
    state,
    code: MAINTENANCE_ERROR_CODE_BY_MODE[mode],
    message: DEFAULT_MESSAGES[mode],
  }
}

// issue #694 の API 設計（WriteGuardOptions）に合わせた命名。
export interface WriteGuardOptions {
  /** ログ相関用の操作名（例: 'cards.collections.patch'）。秘密情報を含めないこと。 */
  operation: string
  /** このモード一覧に現在の mode が含まれる場合は拒否しない（例: EventSub 経路等）。 */
  allowDuring?: MaintenanceMode[]
}

/**
 * JSON API 用の write guard。
 *
 * 許可時は null を返す（呼び出し元はそのまま通常処理を続ける）。
 * 拒否時は issue #694 のレスポンス仕様に沿った 503 JSON を返す:
 *   { error: { code, message, retryable: true, expectedEndAt? } }
 *
 * Cache-Control: private, no-store を必ず設定する（CDN がメンテナンス応答を
 * 長期キャッシュして解除後も古い 503 を配り続ける事故を防ぐため）。
 */
export function guardWrite(options: WriteGuardOptions): NextResponse | null {
  const rejection = evaluateGuard(options.allowDuring)
  if (!rejection) {
    return null
  }

  logger.warn(
    `[maintenance] write blocked: operation=${options.operation} mode=${rejection.state.mode}`,
    { operationId: rejection.state.operationId }
  )

  const response = NextResponse.json(
    {
      error: {
        code: rejection.code,
        message: rejection.message,
        retryable: true,
        ...(rejection.state.expectedEndAt
          ? { expectedEndAt: rejection.state.expectedEndAt }
          : {}),
      },
    },
    { status: 503 }
  )
  response.headers.set(
    'Retry-After',
    String(computeRetryAfterSeconds(rejection.state.expectedEndAt))
  )
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export interface GuardWriteRedirectOptions {
  /** ログ相関用の操作名。guardWrite の operation と同じ意味。 */
  operation: string
  /**
   * 拒否時のリダイレクト先。open redirect を避けるため相対パスのみ許可する
   * （例: '/?maintenance=1'）。不正な値が渡された場合は '/' にフォールバックする。
   */
  redirectTo: string
}

/**
 * ブラウザナビゲーション（OAuth callback 等、JSON 503 をユーザーが直接見てしまう
 * route）向けの redirect 版 write guard。
 *
 * この関数は request を受け取らない（＝オリジンを知らない）設計のため、
 * NextResponse.redirect() が要求する絶対 URL を組み立てられない。代わりに
 * Location ヘッダーへ相対パスを直接設定する。相対パスの Location は
 * RFC 7231 7.1.2 で許容されており、主要ブラウザはリクエスト先オリジンを基準に
 * 解決するため、絶対 URL を渡すのと同じようにナビゲーションできる。
 * allowDuring は用意しない: ブラウザ直撃 route は EventSub のような特別扱いが
 * 不要な一般 write 経路のみを想定しているため（YAGNI）。
 */
export function guardWriteRedirect(
  options: GuardWriteRedirectOptions
): NextResponse | null {
  const rejection = evaluateGuard()
  if (!rejection) {
    return null
  }

  logger.warn(
    `[maintenance] write blocked (redirect): operation=${options.operation} mode=${rejection.state.mode}`,
    { operationId: rejection.state.operationId }
  )

  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: toSafeRedirectPath(options.redirectTo),
      'Cache-Control': 'private, no-store',
    },
  })
}

/**
 * redirectTo を「安全な相対パス」に限定する。
 *
 * ブラックリスト方式（禁止文字を列挙）ではなく、ホワイトリスト方式
 * （許可する文字だけを列挙）で判定する: 先頭が単一の "/" で、以降は
 * printable ASCII（0x21-0x7e、"!" 〜 "~"）のみで構成された文字列だけを通す。
 * これにより次の両方が一度に塞がれる。
 *   - 制御文字・空白（0x00-0x20, 0x7f の DEL 含む）: Location ヘッダーへの
 *     CRLF インジェクションや、DEL がフロントエンド/プロキシで想定外に
 *     正規化されるリスクへの対策
 *   - 非 ASCII 文字（例: 全角バックスラッシュ U+FF3C, 日本語パス等）:
 *     一部の実装は全角記号を半角相当へ正規化することがあり、"\" と同様の
 *     プロトコル相対 URL バイパスに転用され得る。Cloudflare Workers
 *     (workerd) の Location ヘッダー処理における非 ASCII / 非 Latin1 文字の
 *     挙動も未検証のため、そもそも通さない方が安全。
 *
 * printable ASCII には "/" (0x2f) や "\" (0x5c) も含まれるため、ホワイトリスト
 * だけでは "//evil.com" や "/\evil.com" のようなプロトコル相対 URL を防げない。
 * そのため "//" 始まりと "\" の混入は個別に拒否する（既存ロジックを維持）。
 *
 * 検証に通らない値は呼び出し元の設定ミスとみなし、安全側のトップページ "/" へ倒す
 * （メンテナンス応答自体が壊れて 500 になるより、常に何かへリダイレクトできる方が良い）。
 */
function toSafeRedirectPath(redirectTo: string): string {
  const isPrintableAsciiPath = /^\/[\x21-\x7e]*$/.test(redirectTo)
  const isNotProtocolRelative = !redirectTo.startsWith('//')
  const hasNoBackslash = !redirectTo.includes('\\')

  return isPrintableAsciiPath && isNotProtocolRelative && hasNoBackslash
    ? redirectTo
    : '/'
}
