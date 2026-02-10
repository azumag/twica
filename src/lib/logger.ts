import { logErrorFromLogger } from './sentry/error-handler'

export const logger = {
  info: (message: string, ...args: unknown[]) => {
    console.log(`[INFO] ${message}`, ...args)
  },
  warn: (message: string, ...args: unknown[]) => {
    console.warn(`[WARN] ${message}`, ...args)
  },
  /**
   * コンソール出力に加え、Supabase errors テーブルに記録する。
   * Cron Worker (twica-error-reporter) が定期的に GitHub Issue を自動作成する。
   * Promise を返すため、確実に記録したい場合は await 可能。
   * await しない場合は fire-and-forget で動作する。
   */
  error: (message: string, ...args: unknown[]): Promise<void> => {
    console.error(`[ERROR] ${message}`, ...args)
    return logErrorFromLogger(message, args)
  },
}
