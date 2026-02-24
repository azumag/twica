/**
 * Cloudflare Workers 型スタブ（ルートプロジェクト用）
 *
 * workers/ 以下のソースをテストファイルが import する際、
 * Next.js ビルドの型チェックでルート tsconfig コンテキストが使われる。
 * @cloudflare/workers-types はルートにインストールされていないため、
 * 最小限の型定義をここで提供する。
 *
 * 各 worker 独自のビルドでは worker 側の tsconfig.json で
 * @cloudflare/workers-types が指定されており、こちらの型は使用されない。
 */

interface ScheduledController {
  readonly scheduledTime: number
  readonly cron: string
  noRetry(): void
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}
