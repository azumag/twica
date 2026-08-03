import { NextRequest, NextResponse } from "next/server";
import { TWITCH_SUBSCRIPTION_TYPE, ERROR_MESSAGES } from "@/lib/constants";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { logger } from "@/lib/logger.server";
import { reportError } from "@/lib/sentry/error-handler";
import { CHAT_SEND_TERMINAL_CODES } from "@/lib/twitch/chat-service";
import {
  listParkedEventSubNotifications,
  deleteParkedEventSubNotification,
} from "@/lib/maintenance/eventsub-park";
import {
  claimDueChatNotifications,
  decodeChatNotificationPayload,
  deadLetterChatNotification,
  markChatNotificationSent,
  peekChatNotificationOutboxWork,
  renewChatNotificationLease,
  retryChatNotification,
} from "@/lib/services/chat-notification-outbox";
import {
  handleRedemption,
  handleRaidNotification,
  postRedemptionNotify,
  sendChatAnnouncement,
} from "@/lib/services/eventsub-redemption";

/**
 * EventSubリプレイ機構 (Issue #787)
 *
 * 背景: issue #694 の maintenance mode 中は EventSub notification (ガチャ交換 /
 * レイド) を DB へ書き込まず KV へ退避するだけで（src/lib/maintenance/eventsub-park.ts
 * の parkEventSubNotification）、再処理する仕組みが無かった。その結果、メンテ中に
 * ガチャ交換した視聴者はポイントを消費してもカードを受け取れないまま放置される。
 * 本routeは、退避された通知を一括で再処理（リプレイ）するための運用エンドポイント。
 *
 * 冪等性: execute_gacha_transaction (migration 00076) の event_id UNIQUE 制約 +
 * ON CONFLICT (event_id) DO NOTHING により、同じ退避エントリを重複処理しても
 * 二重付与は起きない（詳細は eventsub-park.ts のリプレイ実装者への注記を参照）。
 *
 * maintenance再チェックをここで行わない理由: issue #694 案Bのアーキテクチャでは
 * middleware（checkMaintenanceWriteBlock）が config/maintenance-write-surfaces.json
 * のallowlistに基づき一元的にブロック判定を行う。本routeも他のwrite routeと同様に
 * "block" として登録済みであり（メンテ解除後(mode=off)にのみ実行する運用のため）、
 * route自身が独自にmaintenance状態を再チェックする冗長ガードは追加しない。
 */

/**
 * X-Replay-Secret ヘッダーと EVENTSUB_REPLAY_SECRET を定数時間で比較する。
 *
 * route.ts の verifyTwitchSignature と同じロジックを踏襲する（タイミング攻撃対策の
 * ため、長さ不一致を検知した後も最後まで全文字を比較し、早期returnしない）。
 * csrf.ts の validateCSRFToken も同種の定数時間比較を実装しているが、あちらは
 * Web Crypto API 由来のハッシュ値（Uint8Array）比較用であり、本routeが比較する
 * 生の秘密文字列の比較にはそのまま流用できないため、verifyTwitchSignatureと
 * 同じ文字列ベースの実装を踏襲する。
 */
function timingSafeEqualString(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) {
    return false;
  }

  let isValid = true;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      isValid = false;
      // 早期breakしない（定数時間を維持するため）
    }
  }

  return isValid;
}

/** リクエストボディの1バッチあたりの取得件数の既定値・上限値。 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
// 呼び出し元CronのHTTP timeoutは120秒。応答・ログ書き込み用に15秒を残し、
// 105秒で新規work開始を停止する。20件を各最大約9.75秒で直列送信すると
// 120秒を超えるため、件数上限だけでなくwall-clock budgetも必須。
const EVENTSUB_REPLAY_BUDGET_MS = 105_000;
// Helix chatは3秒timeout×3回 + 250/500ms backoffで最大約9.75秒。route deadline
// 直前に送信を始めると、Promise.raceが成功結果を捨ててackせず次tickで重複する。
// 15秒前から新しい外部送信を禁止し、開始済み送信・JSON decode・DB ackを収容する。
const CHAT_SEND_SETTLEMENT_RESERVE_MS = 15_000;
// DB outboxが常に満杯でも、同じrequest内でmaintenance KVを処理する余地を残す。
// 次tickは未claim行を期限順に続行するため、throughputより公平性とtimeout回避を優先。
const CHAT_OUTBOX_RELAY_LIMIT = 5;

interface ReplayRequestBody {
  cursor?: string;
  limit?: number;
  dryRun?: boolean;
}

type DeadlineResult<T> =
  | { completed: true; value: T }
  | { completed: false };

/**
 * 非協調的なDB/token処理が長引いてもrouteをCronの120秒より前に返す。
 * timeout後も元Promiseが解決する可能性はあるため、Twitch外部送信側でも
 * deadline + owner-fenceを検査し、遅延完了した旧処理が送信しない二重防御にする。
 */
async function awaitBeforeReplayDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
): Promise<DeadlineResult<T>> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return { completed: false };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timeoutId = setTimeout(() => resolve({ completed: false }), remainingMs);
  });
  try {
    return await Promise.race([
      operation.then((value): DeadlineResult<T> => ({ completed: true, value })),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * 1エントリのリプレイ結果。
 *
 * outcome の意味:
 * - succeeded: DB書き込み・通知まで完了した
 * - skipped: handleRedemption/handleRaidNotification内部で重複・報酬不一致等の
 *   正当な理由で { notify: null, retryable: false } が返った
 *   （確定的な終端結果、リトライ不要）
 * - failed: handleRedemption/handleRaidNotification が例外をthrowしたか、
 *   { notify: null, retryable: true }（DB一時障害等、既知の終端理由の
 *   どれにも一致しない予期しない失敗）を返した
 *   （どちらも再試行で解決しうる。KVエントリは削除せず残す。Issue #787
 *   2巡目レビュー: 以前は retryable な失敗も一律 skipped 扱いでKVエントリを
 *   削除しており、再試行すれば成功したかもしれないガチャ交換が永久に
 *   失われるバグがあった）
 * - dry-run: dryRun時、対象になったことだけを報告する
 * - unknown-type: 未対応のsubscriptionType（中-2: fail-safe。KVエントリは
 *   削除しない。park側と同じ「将来subscriptionTypeが増えても退避漏れを
 *   構造的に防ぐ」設計思想に合わせ、replay側の分岐追加を忘れても
 *   データが黙って消えないようにする）
 * - invalid-payload: payload.event が欠落/非object等、データ自体が壊れている
 *   （低-6: DB一時障害と違いリトライしても永久に解決しないため、
 *   このケースに限りKVエントリを削除してよい）
 */
interface ReplayResultEntry {
  key: string;
  messageId: string;
  subscriptionType: string;
  receivedAt: string;
  outcome: "succeeded" | "skipped" | "failed" | "dry-run" | "unknown-type" | "invalid-payload";
  error?: string;
}

/**
 * record.payload（KV退避時点の生 EventSub notification）から event フィールドを
 * 取り出す。payload は `{ subscription, event, ... }` 形式で、handleRedemption /
 * handleRaidNotification の event 引数とそのまま一致する
 * （eventsub-park.ts のドキュメントコメント参照）。
 */
function extractPayloadEvent(payload: unknown): unknown {
  return (payload as { event?: unknown } | null)?.event;
}

/**
 * payload.event が最低限objectとして解釈可能かを検証する（低-6）。
 * handleRedemption/handleRaidNotification は event のプロパティへ直接アクセスする
 * ため、event が undefined/null/非object だとTypeErrorが発生し、DB一時障害と
 * 区別のつかない "failed" 扱いになってしまう。ここでは深い構造（reward の有無等）
 * までは検証しない（YAGNI: そこまで壊れたデータは想定していない。深い破損は
 * 従来どおり例外経由で "failed" として扱われ、再試行対象として残る）。
 */
function isValidPayloadEvent(event: unknown): event is Record<string, unknown> {
  return typeof event === "object" && event !== null;
}

/**
 * KVエントリの削除を試みる。失敗しても results への追加pushは行わない
 * （中-1のバグ修正: deleteParkedEventSubNotification が kv.delete() の例外で
 * throwした場合、呼び出し元のtry/catchに落ちて同一キーに対し succeeded/skipped
 * と failed の2エントリが results に積まれ、counts が矛盾していた）。
 * 削除に失敗してもデータロスではない（KEY_PREFIX の TTL 7日でいずれ自動的に
 * 消える、eventsub-park.ts の deleteParkedEventSubNotification 側コメント参照）
 * ため、ログのみに留める。
 */
async function deleteParkedEntrySafely(key: string, messageId: string): Promise<void> {
  try {
    await deleteParkedEventSubNotification(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      "[eventsub-replay] failed to delete parked entry after processing, will expire via TTL",
      { key, messageId, error: message }
    );
  }
}

/**
 * reportError呼び出しを例外から保護する（最終レビュー低-A）。
 * 現行の reportError 実装は DB 書き込み失敗を内部で catch 済みのため実質的に
 * rejectしないが、将来の実装変更で例外を投げるようになった場合に備え、
 * deleteParkedEntrySafely と同じ考え方でここでも例外を握りつぶす
 * （この1件の2次報告の失敗でバッチ全体（後続エントリの処理）を止めないため）。
 * reportError 自体が errors テーブル記録 → GitHub Issue 自動起票の経路なので、
 * reportError が失敗した場合の二次ログは logger.warn に留め、過剰なエスカレー
 * ションはしない。
 */
async function reportErrorSafely(
  error: Error,
  context: Record<string, unknown>
): Promise<void> {
  try {
    await reportError(error, context);
  } catch (reportFailure) {
    const message =
      reportFailure instanceof Error ? reportFailure.message : String(reportFailure);
    logger.warn("[eventsub-replay] reportError itself failed, continuing batch", {
      ...context,
      error: message,
    });
  }
}

export async function POST(request: NextRequest) {
  const replayDeadlineAt = Date.now() + EVENTSUB_REPLAY_BUDGET_MS;
  const externalChatSendDeadlineAt =
    replayDeadlineAt - CHAT_SEND_SETTLEMENT_RESERVE_MS;
  // fail-closed: シークレット自体が未設定の場合は、設定忘れで誰でもアクセス
  // できてしまう事故を防ぐため 500 を返す（403 ではなく、運用側の設定不備を
  // 明確に区別するため）。
  const expectedSecret = process.env.EVENTSUB_REPLAY_SECRET;
  if (!expectedSecret) {
    logger.error("[eventsub-replay] EVENTSUB_REPLAY_SECRET is not configured");
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    );
  }

  const providedSecret = request.headers.get("x-replay-secret") || "";
  if (!providedSecret || !timingSafeEqualString(expectedSecret, providedSecret)) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
  }

  // セッションが存在しない運用エンドポイントのため ip: ベースの識別子を使う
  // （route.ts の notification 以外の messageType 向けレート制限と同じ形）。
  const identifier = await getRateLimitIdentifier(request);
  const rateLimitResult = await checkRateLimit(rateLimits.eventsubReplay, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimitResult.limit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(rateLimitResult.reset),
        },
      }
    );
  }

  // リクエストボディは全フィールド省略可能。空ボディも許可する
  // （運用スクリプトが body 無しでもページネーション先頭バッチを叩けるように）。
  let requestBody: ReplayRequestBody = {};
  const rawBody = await request.text();
  if (rawBody) {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    // JSON.parse の戻り値は unknown（TypeScriptの型は実行時を保証しない）。
    // ReplayRequestBody へキャストする前に object であることを確認し、
    // 直後の requestBody.limit / requestBody.cursor アクセスが null/配列/プリミティブ
    // 相手にクラッシュしないようにする。
    if (typeof parsedBody !== "object" || parsedBody === null) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    requestBody = parsedBody as ReplayRequestBody;
  }

  // 型バリデーション（低-7）: limit が数値以外（文字列等）だと下のclamp計算が
  // NaN になり、Math.min/Math.max による上限・下限チェックが機能しなくなる
  // （実測確認済み）。cursor も KV の cursor トークンとして渡すため文字列以外は
  // 弾く。どちらも不正なら 400 で早期returnする。
  if (requestBody.limit !== undefined && !Number.isInteger(requestBody.limit)) {
    return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
  }
  if (requestBody.cursor !== undefined && typeof requestBody.cursor !== "string") {
    return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
  }
  const dryRun = requestBody.dryRun === true;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, requestBody.limit ?? DEFAULT_LIMIT)
  );

  const results: ReplayResultEntry[] = [];

  if (dryRun) {
    const workItems = await peekChatNotificationOutboxWork(limit);
    for (const item of workItems) {
      results.push({
        key: `chat-outbox:${item.id}`,
        messageId: item.batchId,
        subscriptionType: "twica.transactional-chat-outbox.v1",
        receivedAt: item.createdAt,
        outcome: "dry-run",
      });
    }
  }

  // transactional chat outboxはKV maintenance backlogと別の公平なlimitで処理する。
  // 恒久失敗は即DLQ、一時失敗はnext_attempt_atへ戻すため、古い20件が後続の
  // カード付与EventSubを塞ぐことはない。さらにKV一覧取得より先に処理することで、
  // KV障害時もDB outboxの配送を進める。KV取得が後で失敗するとroute自体は失敗するが、
  // Cronの次回実行ごとに独立したchat batchをdrainでき、KV復旧を待つ必要がない。
  // dry-runはclaim/状態変更を一切しない。
  if (!dryRun) {
    // まとめてleaseして直列送信すると後半のleaseが送信前に失効するため、
    // 1件claim→送信→ackを繰り返す。最初のclaimだけ保持期限メンテナンスも行う。
    const chatOutboxLimit = Math.min(limit, CHAT_OUTBOX_RELAY_LIMIT);
    for (let claimIndex = 0; claimIndex < chatOutboxLimit; claimIndex += 1) {
      if (Date.now() >= replayDeadlineAt) break;
      const claimResult = await awaitBeforeReplayDeadline(
        claimDueChatNotifications(1, {
          maintain: claimIndex === 0,
        }),
        replayDeadlineAt,
      );
      if (!claimResult.completed) break;
      const [claim] = claimResult.value;
      if (!claim) break;
      const baseResult = {
        key: `chat-outbox:${claim.id}`,
        messageId: claim.batchId,
        subscriptionType: "twica.transactional-chat-outbox.v1",
        receivedAt: claim.createdAt,
      };

      const data = decodeChatNotificationPayload(claim);
      if (!data) {
        const error = `transactional chat outbox payload v${claim.payloadVersion} is invalid`;
        const persisted = await deadLetterChatNotification(claim, error);
        if (!persisted) {
          logger.warn("[eventsub-replay] invalid payload DLQ update lost its lease", {
            outboxId: claim.id,
            messageId: claim.batchId,
          });
        }
        await reportErrorSafely(new Error(`[eventsub-replay] ${error}`), {
          key: baseResult.key,
          messageId: claim.batchId,
          subscriptionType: baseResult.subscriptionType,
        });
        results.push({ ...baseResult, outcome: "invalid-payload", error });
        continue;
      }

      try {
        const deliveryResult = await awaitBeforeReplayDeadline(
          sendChatAnnouncement(
            data.broadcasterTwitchUserId,
            data.streamer,
            data.gachaResult.card,
            data.gachaResult.userTwitchUsername,
            data.userId,
            data.gachaResult.cards,
            data.gachaResult.collectionName,
            data.chatSnapshot,
            async () => {
              if (Date.now() >= externalChatSendDeadlineAt) return false;
              const renewed = await renewChatNotificationLease(claim);
              // renew自体が接続待ちで開始期限を跨ぐ場合がある。更新成功だけで
              // 送信許可せず、実際のHelix fetch直前時刻も必ず再確認する。
              return renewed && Date.now() < externalChatSendDeadlineAt;
            },
          ),
          replayDeadlineAt,
        );
        if (!deliveryResult.completed) {
          // 送信Promiseが後から資格情報解決を終えても上のdeadline fenceでTwitchへ
          // 到達しない。行は更新せずlease失効後の次tickへ安全に委ねる。
          results.push({ ...baseResult, outcome: "failed", error: "replay deadline reached" });
          break;
        }
        const outcome = deliveryResult.value;
        if (outcome.outcome === "sent" || outcome.outcome === "skipped") {
          const persisted = await markChatNotificationSent(claim);
          if (!persisted) {
            // Twitch送信成功とDB ackは原子的にできない。owner leaseを失っていた場合は
            // 別relayが再送する可能性があるため、黙って成功扱いにせず運用へ通知する。
            await reportErrorSafely(
              new Error("[eventsub-replay] chat sent but outbox ack lost its lease"),
              {
                key: baseResult.key,
                messageId: claim.batchId,
                ...(outcome.degradation ? { degradation: outcome.degradation } : {}),
              }
            );
          } else if (outcome.degradation) {
            // 配送成功はackしたまま、設定BOTの恒久失効だけをreplay所有境界で
            // 1回永続化する。sentをDLQへ戻すと同じ本文を再送してしまう。
            await reportErrorSafely(
              new Error(
                `[eventsub-replay] chat sent using fallback sender: ${outcome.degradation.reason}`,
              ),
              {
                key: baseResult.key,
                messageId: claim.batchId,
                degradation: outcome.degradation,
              },
            );
          }
          results.push({
            ...baseResult,
            outcome: persisted
              ? (outcome.outcome === "sent" ? "succeeded" : "skipped")
              : "failed",
            ...(persisted ? {} : { error: "sent, but outbox ack lost its lease" }),
          });
        } else if (outcome.outcome === "terminal") {
          const persisted = await deadLetterChatNotification(claim, outcome.reason);
          // live EventSub経路と同じ契約: scope不足はユーザーの再認証待ちなので、
          // DLQと構造化ログは残すが自動Issue化しない。reason文字列ではなく
          // chat-serviceのtyped codeで判定し、Twitch文言変更による誤分類を防ぐ。
          // token欠落・401・未知terminalは引き続きreportErrorSafelyへ送る。
          if (outcome.code === CHAT_SEND_TERMINAL_CODES.MISSING_SCOPE && persisted) {
            logger.info("[eventsub-replay] chat notification moved to DLQ pending Twitch reauthorization", {
              key: baseResult.key,
              messageId: claim.batchId,
              outboxId: claim.id,
              code: outcome.code,
              reason: outcome.reason,
              persisted,
            });
          } else {
            await reportErrorSafely(
              new Error(
                persisted
                  ? `[eventsub-replay] chat notification moved to DLQ: ${outcome.reason}`
                  : `[eventsub-replay] chat notification DLQ update lost its lease: ${outcome.reason}`,
              ),
              { key: baseResult.key, messageId: claim.batchId, persisted }
            );
          }
          results.push({ ...baseResult, outcome: "failed", error: `DLQ: ${outcome.reason}` });
        } else if (outcome.outcome === "retryable") {
          const state = await retryChatNotification(claim, outcome.reason);
          if (state === "lost-lease" || state === "dead") {
            // pendingは通常のbounded retryなので毎回の通報を避ける。一方、deadは
            // 上限到達後の最終状態であり、この通報がないとDB scope確認不能などの
            // 一時障害が恒久DLQ化しても運用側が検知できない。
            await reportErrorSafely(
              new Error(
                state === "lost-lease"
                  ? "[eventsub-replay] chat retry update lost its lease"
                  : `[eventsub-replay] chat delivery exhausted retries: ${outcome.reason}`,
              ),
              { key: baseResult.key, messageId: claim.batchId, state }
            );
          }
          results.push({
            ...baseResult,
            outcome: "failed",
            error: `${state}: ${outcome.reason}`,
          });
        } else {
          // lost lease / deadline / fence障害時は、新所有者の状態を上書きしない。
          // missing_scope以外を黙殺しない契約に合わせ、outbox更新は行わずとも
          // 運用障害としてawait済みのreportErrorへ残す。
          await reportErrorSafely(
            new Error(`[eventsub-replay] chat delivery aborted: ${outcome.reason}`),
            { key: baseResult.key, messageId: claim.batchId },
          );
          results.push({ ...baseResult, outcome: "failed", error: outcome.reason });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const state = await retryChatNotification(claim, message);
        // deadLetter/ack/send自体のthrowもmissing_scope抑制の外側である。logger.errorの
        // fire-and-forget永続化だけに依存せず、request内でreport完了を待つ。
        await reportErrorSafely(
          new Error(`[eventsub-replay] transactional chat relay failed: ${message}`),
          { key: baseResult.key, messageId: claim.batchId, state },
        );
        logger.warn("[eventsub-replay] transactional chat relay failed", {
          outboxId: claim.id,
          messageId: claim.batchId,
          state,
          error: message,
        });
        results.push({ ...baseResult, outcome: "failed", error: `${state}: ${message}` });
      }
    }
  }

  // non-dry-runではDB outboxとKVを合わせてrequest limit以内に収める。
  // DB側で上限を消費した場合やdeadline到達時はcursorを進めず、次tickで同じ
  // backlogを確実に再評価する。dry-runは両保存先の最古候補比較だけなので別枠。
  const remainingKvLimit = dryRun ? limit : Math.max(0, limit - results.length);
  const parkedListResult = remainingKvLimit > 0 && Date.now() < replayDeadlineAt
    ? await awaitBeforeReplayDeadline(
        listParkedEventSubNotifications({
          cursor: requestBody.cursor,
          limit: remainingKvLimit,
        }),
        replayDeadlineAt,
      )
    : { completed: false as const };
  const {
    entries,
    cursor,
    listComplete,
  } = parkedListResult.completed
    ? parkedListResult.value
    : {
        entries: [],
        cursor: requestBody.cursor,
        listComplete: false,
      };

  for (const { key, record } of entries) {
    if (!dryRun && Date.now() >= replayDeadlineAt) break;
    const baseResult = {
      key,
      messageId: record.messageId,
      subscriptionType: record.subscriptionType,
      receivedAt: record.receivedAt,
    };

    if (dryRun) {
      // dry-run: 実行もKV削除も行わず、対象になったことだけを報告する。
      results.push({ ...baseResult, outcome: "dry-run" });
      continue;
    }

    if (record.subscriptionType === TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD) {
      const payloadEvent = extractPayloadEvent(record.payload);

      if (!isValidPayloadEvent(payloadEvent)) {
        // 低-6: payload.event が欠落/非objectの場合、handleRedemption側の
        // プロパティアクセスでTypeErrorとなり catch 節で "failed" になってしまい
        // TTL失効(7日)までリトライされ続ける。データ破損はリトライしても
        // 解決しないため、事前検証で区別して即座に終端させる。
        results.push({ ...baseResult, outcome: "invalid-payload" });
        // ガチャ経済に関わるデータロスの可能性があるため、ログのみに留めず
        // errors テーブル記録 → GitHub Issue 自動起票の経路に乗せる。
        await reportErrorSafely(
          new Error("[eventsub-replay] parked payload missing/invalid event field"),
          { key, messageId: record.messageId, subscriptionType: record.subscriptionType }
        );
        await deleteParkedEntrySafely(key, record.messageId);
        continue;
      }

      try {
        const handleResult = await awaitBeforeReplayDeadline(
          handleRedemption(
            record.messageId,
            payloadEvent as Parameters<typeof handleRedemption>[1],
          ),
          replayDeadlineAt,
        );
        if (!handleResult.completed) {
          results.push({ ...baseResult, outcome: "failed", error: "replay deadline reached" });
          break;
        }
        const result = handleResult.value;

        if (result.notify) {
          // バッチ処理の完了をレスポンスで正確に報告するため、waitUntilではなく
          // 同期awaitする（既存のライブ経路のレイテンシ最適化とは異なる要件）。
          const notifyResult = await awaitBeforeReplayDeadline(
            postRedemptionNotify(result.notify, {
              externalSendDeadlineAt: externalChatSendDeadlineAt,
            }),
            replayDeadlineAt,
          );
          if (!notifyResult.completed) {
            results.push({ ...baseResult, outcome: "failed", error: "replay deadline reached" });
            break;
          }
          results.push({ ...baseResult, outcome: "succeeded" });
          await deleteParkedEntrySafely(key, record.messageId);
        } else if (result.retryable) {
          // Issue #787 2巡目レビュー: DB一時障害等、既知の終端理由のどれにも
          // 一致しない予期しない失敗。再試行すれば成功する可能性があるため、
          // KVエントリは削除せず残す（この分岐が今回のバグ修正の核心）。
          results.push({
            ...baseResult,
            outcome: "failed",
            error: "gacha execution returned a retryable failure",
          });
        } else {
          // handleRedemption内部で重複/報酬不一致/カード無し/売り切れ等の
          // 確定的な終端結果は既にログ済みのため、ここでは skip 扱いにする。
          results.push({ ...baseResult, outcome: "skipped" });
          await deleteParkedEntrySafely(key, record.messageId);
        }
      } catch (error) {
        // このエントリの失敗でバッチ全体を止めず、KVエントリも削除せず
        // 再試行・調査のために残す。
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[eventsub-replay] handleRedemption threw, keeping parked entry", {
          key,
          messageId: record.messageId,
          error: message,
        });
        results.push({ ...baseResult, outcome: "failed", error: message });
      }
      continue;
    }

    if (record.subscriptionType === TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID) {
      const payloadEvent = extractPayloadEvent(record.payload);

      if (!isValidPayloadEvent(payloadEvent)) {
        results.push({ ...baseResult, outcome: "invalid-payload" });
        await reportErrorSafely(
          new Error("[eventsub-replay] parked payload missing/invalid event field"),
          { key, messageId: record.messageId, subscriptionType: record.subscriptionType }
        );
        await deleteParkedEntrySafely(key, record.messageId);
        continue;
      }

      try {
        const handleResult = await awaitBeforeReplayDeadline(
          handleRaidNotification(
            record.messageId,
            payloadEvent as Parameters<typeof handleRaidNotification>[1],
          ),
          replayDeadlineAt,
        );
        if (!handleResult.completed) {
          results.push({ ...baseResult, outcome: "failed", error: "replay deadline reached" });
          break;
        }
        const result = handleResult.value;

        if (result.notify) {
          const notifyResult = await awaitBeforeReplayDeadline(
            postRedemptionNotify(result.notify, {
              externalSendDeadlineAt: externalChatSendDeadlineAt,
            }),
            replayDeadlineAt,
          );
          if (!notifyResult.completed) {
            results.push({ ...baseResult, outcome: "failed", error: "replay deadline reached" });
            break;
          }
          results.push({ ...baseResult, outcome: "succeeded" });
          await deleteParkedEntrySafely(key, record.messageId);
        } else if (result.retryable) {
          // Issue #787 2巡目レビュー: CHANNEL_POINTS_REDEMPTION_ADD側と同じ理由で
          // KVエントリを残す（詳細はそちら側のコメント参照）。
          results.push({
            ...baseResult,
            outcome: "failed",
            error: "gacha execution returned a retryable failure",
          });
        } else {
          results.push({ ...baseResult, outcome: "skipped" });
          await deleteParkedEntrySafely(key, record.messageId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[eventsub-replay] handleRaidNotification threw, keeping parked entry", {
          key,
          messageId: record.messageId,
          error: message,
        });
        results.push({ ...baseResult, outcome: "failed", error: message });
      }
      continue;
    }

    // 未知のsubscriptionType（中-2）: park側（eventsub-park.ts）はnotification
    // 全件を退避するfail-safe設計（将来subscriptionTypeが追加された際の退避漏れを
    // 構造的に防ぐ）になっている。replay側で即座にKV削除してしまうと、将来DB書き込みを
    // 伴う新しいsubscriptionTypeが追加されリプレイ側の分岐追加を誰かが忘れた場合に、
    // 退避データが黙って失われるfail-openになってしまう。そのためKVエントリは
    // 削除せず、TTL(7日)に任せる（または運用者が手動対応できるよう残す）。
    results.push({ ...baseResult, outcome: "unknown-type" });
  }

  if (dryRun) {
    // DB outboxとKVは別々に時系列取得されるため、workerがresults[0]を全体の最古
    // として安全マージン判定できるよう、結合後にISO8601時刻で再整列する。
    results.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  const counts = {
    succeeded: results.filter((r) => r.outcome === "succeeded").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    unknownType: results.filter((r) => r.outcome === "unknown-type").length,
    invalidPayload: results.filter((r) => r.outcome === "invalid-payload").length,
    total: results.length,
  };

  return NextResponse.json({
    dryRun,
    cursor,
    listComplete,
    results,
    counts,
  });
}
