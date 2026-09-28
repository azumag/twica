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

// Issue #1665: workers/chat-delivery/src/index.ts (Queue consumer) 用に追加。
// 実際のCloudflare Queues APIの最小サブセットのみ定義する
// (ack/retry/messages以外は未使用のため定義しない。YAGNI)。
interface Message<Body = unknown> {
  readonly id: string
  readonly timestamp: Date
  readonly body: Body
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}

interface MessageBatch<Body = unknown> {
  readonly queue: string
  readonly messages: readonly Message<Body>[]
  ackAll(): void
  retryAll(options?: { delaySeconds?: number }): void
}
