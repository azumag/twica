import { logErrorFromLogger } from './sentry/error-handler'

export const logger = {
  info: (message: string, ...args: unknown[]) => {
    console.log(`[INFO] ${message}`, ...args)
  },
  warn: (message: string, ...args: unknown[]) => {
    console.warn(`[WARN] ${message}`, ...args)
  },
  /**
   * コンソール出力に加え、Supabase errors テーブルに fire-and-forget で記録する。
   * Cron Worker (twica-error-reporter) が定期的に GitHub Issue を自動作成する。
   *
   * Supabase 記録完了を待つ必要がある場合（Cloudflare Workers のレスポンス返却前等）は
   * logErrorFromLogger を直接 await すること（error-handler.ts 参照）。
   */
  error: (message: string, ...args: unknown[]): void => {
    console.error(`[ERROR] ${message}`, ...args)
    // fire-and-forget: logErrorFromLogger は内部 try-catch で例外を握り潰すため reject しない
    void logErrorFromLogger(message, args)
  },
}
