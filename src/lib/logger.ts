import { sanitizeLogArg } from './log-sanitizer'

/**
 * ブラウザ・サーバー両方から利用できるconsole logger。
 *
 * このモジュールはClient Componentからimportされるため、DBやNode.js APIを使う
 * server-only moduleを依存グラフへ含めてはならない。サーバーでconsole出力に加えて
 * errorsテーブルへ永続化する必要がある呼び出し元は`@/lib/logger.server`を使う。
 * `logger.server`はこのloggerへconsole出力を委譲するので、マスキング規則と出力形式は
 * 両runtimeで共通のまま維持される。
 *
 * 全consoleログ経路で同一の機密情報マスキングを適用するため、出力前にargsを
 * サニタイズする。
 *
 * Sanitize args before they reach console.* so that Cloudflare Workers logs,
 * browser consoles, and server consoles all follow the same redaction policy.
 * Without this guard, raw context (OAuth codes, access tokens, cookies, session
 * identifiers, etc.) could leak via `console.log/warn/error`.
 *
 * Error instances pass through untouched: their `.message` / `.stack` are
 * developer-authored strings and are assumed not to contain secrets.
 */
export const logger = {
  info: (message: string, ...args: unknown[]) => {
    console.log(`[INFO] ${message}`, ...args.map(sanitizeLogArg))
  },
  warn: (message: string, ...args: unknown[]) => {
    console.warn(`[WARN] ${message}`, ...args.map(sanitizeLogArg))
  },
  error: (message: string, ...args: unknown[]): void => {
    console.error(`[ERROR] ${message}`, ...args.map(sanitizeLogArg))
  },
}
