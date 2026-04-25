import { logErrorFromLogger } from './sentry/error-handler'
import { sanitizeLogArg } from './log-sanitizer'

/**
 * 全ログ経路（Cloudflare Workers logs / Supabase errors / GitHub Issue）で
 * 同一の機密情報マスキングを適用するため、console 出力前に args をサニタイズする。
 *
 * Sanitize args before they reach console.* so that Cloudflare Workers logs,
 * the Supabase `errors` pipeline, and the auto-generated GitHub Issues all
 * follow the same redaction policy. Without this guard, raw context (OAuth
 * codes, access tokens, cookies, session identifiers, etc.) could leak via
 * `console.log/warn/error` even when the Supabase side is sanitized.
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
  /**
   * コンソール出力に加え、Supabase errors テーブルに fire-and-forget で記録する。
   * Cron Worker (twica-error-reporter) が定期的に GitHub Issue を自動作成する。
   *
   * Supabase 記録完了を待つ必要がある場合（Cloudflare Workers のレスポンス返却前等）は
   * logErrorFromLogger を直接 await すること（error-handler.ts 参照）。
   *
   * 注意: Supabase 側にも sanitizeContext が適用されているため、生の args をそのまま
   * 渡しても DB には機密情報が保存されない。console 出力側だけマスクすれば十分。
   */
  error: (message: string, ...args: unknown[]): void => {
    console.error(`[ERROR] ${message}`, ...args.map(sanitizeLogArg))
    // fire-and-forget: logErrorFromLogger は内部 try-catch で例外を握り潰すため reject しない
    void logErrorFromLogger(message, args)
  },
}
