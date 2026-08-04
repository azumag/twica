import type { ChatSendDegradation } from './chat-service'

/**
 * 失敗系outcomeのreasonへdegradation（設定BOT恒久失効）を畳み込む。
 *
 * token-managerはBOT refresh失敗の永続報告を行わず、呼び出し境界が最終outcomeと
 * 合わせて1回報告する契約になっている。degradationはsent/skippedの成功縮退だけで
 * なくterminal/retryable/abortedにも付与されるため、失敗系のDLQ reason・retry
 * reason・エラー報告がoutcome.reasonしか見ないと「設定BOTが要再認証」という
 * 直接シグナルが本人credential障害との同時発生時にどこにも永続化されない。
 *
 * chat-service.tsではなく専用leafモジュールに置くのは、複数のテストが
 * chat-serviceを手書きfactoryでmockしており（実モジュールを読み込まない）、
 * そこへのexport追加が全factoryの更新を強制するため。この関数は依存を持たず、
 * live境界（eventsub-redemption）とreplay境界（eventsub-replay route）の
 * 両方から実体をそのまま使う。
 */
export function formatChatFailureReason(
  reason: string,
  degradation?: ChatSendDegradation,
): string {
  return degradation ? `${reason}; sender degraded: ${degradation.reason}` : reason
}
