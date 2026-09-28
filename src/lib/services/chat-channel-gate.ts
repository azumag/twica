/**
 * Issue #1665: チャネル単位の外部送信間隔gate。
 *
 * paced-multi-draw-sender.ts の既存 `await delay(MULTI_DRAW_CHAT_INTERVAL_MS)` は
 * 同一プロセス内・同一N連シーケンス内の間隔しか守れない。専用Queue Workerの
 * bounded配送は同じ配信者チャンネルへ向けた複数outbox行（別のN連バッチ、
 * summary、単発ガチャ）を別々のHTTP呼び出し・別々のWorker実行で処理しうるため、
 * プロセス内のsleepだけでは間隔を保証できない。
 *
 * ここではDBの短い原子的UPDATE（migration 20260922100000の
 * reserve_chat_channel_send_slot RPC）で「次に送信してよい時刻」を
 * broadcaster_twitch_user_id単位に単調増加させる。Twitchへの実際のfetch()は
 * この予約の外（呼び出し元）で行うため、外部I/O待ち中にDB行lockを保持しない。
 */
import { getDb } from '@/lib/db/client'
import { withDbRetry } from '@/lib/db/retry'

export interface ChatChannelGateWaitOptions {
  /** 予約が失敗した場合に待つ既定間隔（通常はMULTI_DRAW_CHAT_INTERVAL_MS）。 */
  intervalMs: number
  /** この時刻を過ぎたら新しい予約試行を諦める。 */
  deadlineAt: number
  /** unit test用。productionは実際のsetTimeoutを使用する。 */
  delay?: (milliseconds: number) => Promise<void>
}

export type ChatChannelGateOutcome =
  | { outcome: 'reserved' }
  | { outcome: 'budget-exhausted' }

const defaultDelay = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds)
})

interface ReserveSlotRow {
  reserved: boolean
  wait_until: string
}

/**
 * 指定チャネルの次の送信スロットを予約する。予約に成功するまで
 * （またはdeadlineAtに達するまで）DBが返すwait_untilぶんだけ待って再試行する。
 *
 * ビジーループにならない理由: 予約失敗時にRPCが返すwait_untilは、他の予約者が
 * 既に確保した「次に送信可能な時刻」そのものであり、それまで待てば通常は
 * 次の試行で成功する（他の同時呼び出しが割り込まない限り）。
 */
export async function reserveChatChannelSendSlot(
  broadcasterTwitchUserId: string,
  options: ChatChannelGateWaitOptions,
): Promise<ChatChannelGateOutcome> {
  const delay = options.delay ?? defaultDelay

  for (;;) {
    if (Date.now() >= options.deadlineAt) return { outcome: 'budget-exhausted' }

    const row = await withDbRetry(async () => {
      const { sql } = await getDb()
      const rows = await sql<ReserveSlotRow[]>`
        select * from reserve_chat_channel_send_slot(
          ${broadcasterTwitchUserId},
          ${options.intervalMs}::integer
        )
      `
      return rows[0] ?? null
    }, 'chat channel send gate reservation', { idempotent: true })

    // RPCは常に1行返す契約だが、防御的にnullも予算切れとして扱う。
    if (!row || row.reserved) {
      return row?.reserved ? { outcome: 'reserved' } : { outcome: 'budget-exhausted' }
    }

    const waitUntilMs = Date.parse(row.wait_until)
    const remainingBudgetMs = options.deadlineAt - Date.now()
    if (remainingBudgetMs <= 0) return { outcome: 'budget-exhausted' }

    const waitMs = Number.isFinite(waitUntilMs)
      ? Math.max(0, waitUntilMs - Date.now())
      : options.intervalMs
    await delay(Math.min(waitMs, remainingBudgetMs))
  }
}
