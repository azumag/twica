/**
 * Chat Delivery Queue Worker (Issue #1665)
 *
 * N連ガチャのチャット通知が、EventSub webhookの1回のHTTPレスポンス寿命
 * （実質waitUntil 30秒）に縛られて途中で欠落する問題を修正するための
 * 専用Queue Worker。
 *
 * このファイルはconsumer/scheduled handlerのコードのみを追加する。
 * 実際のCloudflare Queueリソース作成・Service Binding配線・
 * .github/workflows/deploy-cloudflare.ymlへの登録は、このPRの範囲外
 * （Issue #1665 導入順序 Step 2: 「権限のあるデプロイ手順」で行う）。
 * このWorkerは現時点でどのCIパイプラインからもdeployされない。
 *
 * 設計上の制約（Issue #1665本文より）:
 * - Queueメッセージは起床通知（{version, batchId}）のみ。カード・本文・
 *   視聴者名・token・送り先URLを運ばない。実データは必ず本体アプリの
 *   PlanetScaleから読む。
 * - このWorker自身はTwitch OAuth secretやDB接続権限を一切持たない。
 *   本体アプリへService Binding（CHAT_APP）経由でHTTPを投げるだけ。
 * - consumerは内部HTTP呼び出しと後続enqueueをawaitで待つ。未awaitの
 *   処理へ配送を逃がさない。
 */

export const CHAT_DELIVERY_WAKEUP_VERSION = 1 as const;

export interface ChatDeliveryWakeupV1 {
  version: typeof CHAT_DELIVERY_WAKEUP_VERSION;
  batchId: string;
}

/** batchIdはEventSub message ID相当。内部endpoint側の上限と揃える。 */
const MAX_BATCH_ID_LENGTH = 200;

const DELIVER_PATH = "/api/internal/chat-outbox";
// アプリ側の1slice予算（chat-notification-delivery.ts既定20秒）より十分長く、
// かつCloudflare Queue consumerの実行寿命（15分）よりずっと短く取る。
const INTERNAL_CALL_TIMEOUT_MS = 45_000;
// deferred/retryableの見積もりnextAttemptAtが過去・直近すぎる場合の最小遅延。
// DB commitの可視性が追いつく前に再度dueとして扱われる無駄な1往復を避ける。
const MIN_FOLLOWUP_DELAY_SECONDS = 1;
// Cloudflare Queuesの1メッセージあたりdelaySeconds上限（プラットフォーム制約）。
const MAX_FOLLOWUP_DELAY_SECONDS = 12 * 60 * 60;

export interface ChatAppServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface QueueProducerLike {
  send(message: ChatDeliveryWakeupV1, options?: { delaySeconds?: number }): Promise<void>;
}

export interface Env {
  CHAT_APP: ChatAppServiceBinding;
  CHAT_NOTIFICATION_QUEUE: QueueProducerLike;
  /** 本体アプリのベースURL。例: https://twica.bluemoon.works */
  CHAT_APP_BASE_URL: string;
  /** 本体アプリの/api/internal/chat-outboxが検証するのと同じ値。secretとして設定する。 */
  CHAT_DELIVERY_SECRET: string;
}

/**
 * 内部deliverエンドポイントが返すoutcomeの最小形。本体アプリ側の
 * ChatDeliverySliceOutcome（chat-notification-delivery.ts）と同期させる。
 * このWorkerは`kind`と`nextAttemptAt`だけを見て次のアクションを決める
 * ため、フィールド追加には寛容な最小構造にする。
 */
export interface ChatDeliverySliceOutcomeLike {
  kind: string;
  nextAttemptAt?: string;
}

/**
 * 受信したQueueメッセージのbodyを検証する。未知versionや不正な形は
 * 処理せずdropする（ack: 再試行しても解決しないメッセージを無限retryしない）。
 */
export function parseChatDeliveryWakeup(body: unknown): ChatDeliveryWakeupV1 | null {
  if (typeof body !== "object" || body === null) return null;
  const value = body as Record<string, unknown>;
  if (value.version !== CHAT_DELIVERY_WAKEUP_VERSION) return null;
  if (
    typeof value.batchId !== "string"
    || value.batchId.length === 0
    || value.batchId.length > MAX_BATCH_ID_LENGTH
  ) {
    return null;
  }
  return { version: CHAT_DELIVERY_WAKEUP_VERSION, batchId: value.batchId };
}

/**
 * outcome.nextAttemptAtから、Queueのdelay再enqueueに使う秒数を求める。
 * 見積もりがずれてもアプリ側next_attempt_at<=nowの判定がfail-closedに
 * 保護するため、ここでの精度要求は低い（chat-notification-delivery.tsの
 * estimateChatOutboxRetryDelayMsと同じ考え方）。
 */
export function computeFollowupDelaySeconds(nextAttemptAt: string | undefined, now: number = Date.now()): number {
  if (!nextAttemptAt) return MIN_FOLLOWUP_DELAY_SECONDS;
  const target = Date.parse(nextAttemptAt);
  if (!Number.isFinite(target)) return MIN_FOLLOWUP_DELAY_SECONDS;
  const seconds = Math.ceil((target - now) / 1000);
  return Math.max(MIN_FOLLOWUP_DELAY_SECONDS, Math.min(MAX_FOLLOWUP_DELAY_SECONDS, seconds));
}

async function callInternalChatOutbox(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ status: number; outcome: ChatDeliverySliceOutcomeLike | null } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTERNAL_CALL_TIMEOUT_MS);
  try {
    const url = `${env.CHAT_APP_BASE_URL}${DELIVER_PATH}`;
    const response = await env.CHAT_APP.fetch(new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 秘密情報はヘッダーで運ぶ。URLやログには入れない。
        "x-chat-delivery-secret": env.CHAT_DELIVERY_SECRET,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }));
    if (!response.ok) {
      console.warn("[chat-delivery] internal endpoint rejected request", {
        status: response.status,
        action: body.action,
      });
      return { status: response.status, outcome: null };
    }
    const json = await response.json().catch(() => null) as { outcome?: ChatDeliverySliceOutcomeLike } | null;
    return { status: response.status, outcome: json?.outcome ?? null };
  } catch (error) {
    console.warn("[chat-delivery] internal endpoint call threw", {
      action: body.action,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function enqueueFollowup(env: Env, batchId: string, nextAttemptAt: string | undefined): Promise<boolean> {
  try {
    await env.CHAT_NOTIFICATION_QUEUE.send(
      { version: CHAT_DELIVERY_WAKEUP_VERSION, batchId },
      { delaySeconds: computeFollowupDelaySeconds(nextAttemptAt) },
    );
    return true;
  } catch (error) {
    console.warn("[chat-delivery] follow-up enqueue failed", {
      batchId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * 1件のwake-upメッセージを処理する。
 *
 * deliverの結果に応じて:
 * - complete / terminal / not_claimable: このメッセージの役目は終わり。ack。
 * - lease_lost: 所有権は別owner・回収sweepに委ねる。このメッセージも役目は
 *   終わり（無限retryしても解決しない）なのでack。
 * - deferred / retryable: 続きのwake-upをenqueueし、その成功後にだけack。
 *   enqueueが失敗したらこのメッセージをackせず、Queueの通常retryへ委ねる
 *   （outbox行自体はpendingのまま残っており、失われない）。
 * - 内部endpoint呼び出し自体が失敗（ネットワーク・5xx等）: retry。
 */
export async function handleChatDeliveryMessage(
  message: Message<unknown>,
  env: Env,
): Promise<void> {
  const wakeup = parseChatDeliveryWakeup(message.body);
  if (!wakeup) {
    console.warn("[chat-delivery] dropping malformed wakeup message");
    message.ack();
    return;
  }

  const result = await callInternalChatOutbox(env, { action: "deliver", batchId: wakeup.batchId });
  if (!result || !result.outcome) {
    message.retry();
    return;
  }

  if (result.outcome.kind === "deferred" || result.outcome.kind === "retryable") {
    const enqueued = await enqueueFollowup(env, wakeup.batchId, result.outcome.nextAttemptAt);
    if (!enqueued) {
      message.retry();
      return;
    }
  }

  message.ack();
}

/**
 * 回収sweep: due/lease失効行を上限付きでenqueueする。エラーは本体アプリ側の
 * 内部endpointで構造化ログ・reportErrorされる。ここでは追加の状態を持たず、
 * 呼び出しが失敗しても次回の周期実行に委ねる（sweep自体はat-least-onceの
 * 冪等操作であり、1回失敗しても回収遅延が伸びるだけでデータは失われない）。
 */
export async function runChatDeliveryDueSweep(env: Env): Promise<void> {
  const result = await callInternalChatOutbox(env, { action: "dispatch-due" });
  if (!result) {
    console.warn("[chat-delivery] dispatch-due call failed");
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await handleChatDeliveryMessage(message, env);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runChatDeliveryDueSweep(env));
  },
};
