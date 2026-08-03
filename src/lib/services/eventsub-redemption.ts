/**
 * EventSub ガチャ交換・レイド処理ロジック（Issue #787 Stage 1: route.ts からの抽出）
 *
 * 背景: src/app/api/twitch/eventsub/route.ts に実装されていたガチャ抽選実行・
 * チャット通知・レイド処理のロジックを、以下2つの理由からこのモジュールへ
 * 当初はロジック変更なしで移動した。
 *
 * 1. Issue #787（EventSubリプレイ機構）: メンテナンス中に KV へ退避された
 *    EventSub notification を後から再処理する新規エンドポイント
 *    (src/app/api/admin/eventsub-replay/route.ts) が、Webhook 本体である
 *    route.ts の POST ハンドラを経由せずに handleRedemption /
 *    handleRaidNotification を直接呼び出す必要があるため、export 可能な
 *    独立モジュールに切り出す必要があった。
 * 2. route.ts 側には署名検証・レート制限・revocation/verification処理・
 *    maintenance退避判定など、Webhook受信の関心事のみを残し、実際のガチャ
 *    実行・通知ロジックはこちらに集約する。
 *
 * 抽出後の修正はこの共有モジュールだけに集約し、ライブWebhookとリプレイが
 * 必ず同じPlanetScale・通知契約を使う。
 */
import { GachaService } from "@/lib/services/gacha";
import { TWITCH_CHAT_MESSAGE_MAX_CHARACTERS } from "@/lib/constants";
import { handleApiError } from "@/lib/error-handler";
import { publishCommittedGachaBatch } from "@/lib/overlay-realtime/publisher";
import { logger } from "@/lib/logger.server";
import { reportError } from "@/lib/sentry/error-handler";
import {
  TwitchChatService,
  DEFAULT_CHAT_TEMPLATE,
  type ChatMessagePlaceholders,
} from "@/lib/twitch/chat-service";
import { cancelRedemption } from "@/lib/twitch/channel-points";

import { CARD_ISSUANCE_MESSAGES } from "@/lib/card-issuance";
import { countCharacters } from "@/lib/text-utils";
import { resolvePackDisplayName } from "@/lib/collection-packs";
import { runInBackground } from "@/lib/background-task";
import {
  claimChatNotificationBatch,
  decodeChatNotificationPayload,
  deadLetterChatNotification,
  markChatNotificationSent,
  renewChatNotificationLease,
  retryChatNotification,
} from "@/lib/services/chat-notification-outbox";
import type { GachaCard, EventSubStreamerInfo } from "@/lib/services/gacha";
export { runInBackground } from "@/lib/background-task";
// チャット通知プレースホルダと売り切れ設定を、ガチャ確定と同じPlanetScaleから
// 読む。旧driver設定に関係なくこの単一経路を使う。
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { eq } from "drizzle-orm";
import { streamers as streamersTable } from "@/lib/db/schema";

export const CARD_LIST_SEPARATOR = "、";
export const DEFAULT_MULTI_DRAW_CHAT_TEMPLATE = '@{user} が{draws}連ガチャで {rarityCounts} を獲得しました！{cards}';

/**
 * ガチャ確定後の補助通知エラーをbest-effortで永続化する。
 *
 * Error reporter自体が停止していても、既に確定したカード付与・ポイント返還・
 * EventSub 2xxを巻き戻してはならない。reportErrorは通常内部で失敗を吸収するが、
 * テストdoubleや将来の実装変更がrejectしても通知境界から漏らさないため、ここで
 * 最終防御する。warnはDBを使わずCloudflare Observabilityへ残る。
 */
async function reportNotificationError(
  error: unknown,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await reportError(error, context);
  } catch (reportingError) {
    logger.warn('[EventSub] Failed to persist notification error', {
      context: context.context,
      error: reportingError instanceof Error
        ? reportingError.message
        : String(reportingError),
    });
  }
}
// Issue #597: {packName} でデフォルト(未分類)パックの表示名オーバーライドが
// 未設定の場合のフォールバックラベル。チャット文言は他の箇所(rarityMap等)と
// 同様に i18n非対応でハードコードする。messages/*.json の
// "collections.defaultOnlyName"（コレクションページのパックタブ用ラベル）と
// 同じ文言に揃えている。
export const DEFAULT_PACK_CHAT_FALLBACK_LABEL = "デフォルトパック";

// Issue #544: 売り切れ(発行枚数上限到達)時のチャット通知メッセージ。
// 配信者ごとのカスタムテンプレートは設けず、固定文言にする
// (Issue #544 の実装プラン通り。既存の chat_announcement_enabled フラグのみ再利用する)。
// Issue #546 のポイント返還に成功した場合のみ、返還済みである旨を追記する。
export const SOLD_OUT_CHAT_MESSAGE = 'カードの発行枚数上限に達しているため、カードを付与できませんでした。';
export const SOLD_OUT_CHAT_MESSAGE_REFUNDED_SUFFIX = ' ポイントは返還されました。';

export function formatCardNamesForChat(cardNames: string[], maxCharacters: number): string {
  if (cardNames.length === 0) return "";

  const fullList = cardNames.join(CARD_LIST_SEPARATOR);
  if (countCharacters(fullList) <= maxCharacters) {
    return fullList;
  }

  const total = cardNames.length;
  const displayed: string[] = [];

  for (const cardName of cardNames) {
    const nextDisplayed = [...displayed, cardName];
    const remaining = total - nextDisplayed.length;
    const suffix = remaining > 0 ? ` ほか${remaining}枚（${nextDisplayed.length}/${total}枚表示）` : "";
    const candidate = `${nextDisplayed.join(CARD_LIST_SEPARATOR)}${suffix}`;

    if (countCharacters(candidate) > maxCharacters) {
      break;
    }

    displayed.push(cardName);
  }

  if (displayed.length === 0) {
    const fallback = `ほか${total}枚（0/${total}枚表示）`;
    return countCharacters(fallback) <= maxCharacters ? fallback : `全${total}枚`;
  }

  const remaining = total - displayed.length;
  return `${displayed.join(CARD_LIST_SEPARATOR)} ほか${remaining}枚（${displayed.length}/${total}枚表示）`;
}

export function fitCardNamesForMessage(
  cardNames: string[],
  renderMessage: (cardsText: string) => string,
  // 後段で必ず追記される接尾辞分の文字数を予約しておくことで、
  // 「初出:」追記時の二段階圧縮で末尾切り（truncateCharacters）に陥るのを防ぐ。
  // Reserve characters for a suffix that will be appended later (e.g., " 初出: ...").
  // Without this, the second fit pass cannot shrink {cards} enough and the suffix gets truncated.
  reservedSuffixCharacters: number = 0
): { cardsText: string; message: string } {
  const effectiveLimit = Math.max(0, TWITCH_CHAT_MESSAGE_MAX_CHARACTERS - reservedSuffixCharacters);
  let cardsText = cardNames.join(CARD_LIST_SEPARATOR);
  let message = renderMessage(cardsText);

  for (let i = 0; i < 3 && countCharacters(message) > effectiveLimit; i++) {
    const overflow = countCharacters(message) - effectiveLimit;
    const nextMaxCharacters = Math.max(0, countCharacters(cardsText) - overflow);
    cardsText = formatCardNamesForChat(cardNames, nextMaxCharacters);
    message = renderMessage(cardsText);
  }

  return { cardsText, message };
}

export function formatRarityCountsForChat(cardNamesByRarity: string[]): string {
  if (cardNamesByRarity.length === 0) return "";

  const counts = new Map<string, number>();
  for (const rarity of cardNamesByRarity) {
    counts.set(rarity, (counts.get(rarity) ?? 0) + 1);
  }

  const rarityOrder = ["legendary", "epic", "rare", "common"];
  const rarityMap: Record<string, string> = {
    common: 'コモン',
    rare: 'レア',
    epic: 'エピック',
    legendary: 'レジェンダリー',
  };

  return [...counts.entries()]
    .sort(([a], [b]) => {
      const aIndex = rarityOrder.indexOf(a);
      const bIndex = rarityOrder.indexOf(b);
      return (aIndex === -1 ? rarityOrder.length : aIndex)
        - (bIndex === -1 ? rarityOrder.length : bIndex);
    })
    .map(([rarity, count]) => `${rarityMap[rarity] ?? rarity}x${count}`)
    .join(CARD_LIST_SEPARATOR);
}

type UserCardCountRow = {
  count: unknown;
  card: { id: string; is_active?: boolean };
};

/**
 * 初入手判定で共有する今回の当選数と最終所持数を1回だけ構築する。DB境界では型注釈に
 * 反して文字列等が混入し得るため、ここでは値を正規化せず保持し、安全な新placeholder側が
 * Number.isIntegerでfail-closedに検証できるようにする。既存placeholder側の数値変換は
 * collectNewCardNamesForCurrentDraw内で従来どおり行い、保存済みテンプレートの出力を変えない。
 */
function buildCurrentDrawCountMaps(
  drawnCards: GachaCard[],
  userCardCounts: UserCardCountRow[],
): {
  drawnCounts: Map<string, number>;
  finalCounts: Map<string, unknown>;
} {
  const drawnCounts = new Map<string, number>();
  for (const drawnCard of drawnCards) {
    drawnCounts.set(drawnCard.id, (drawnCounts.get(drawnCard.id) ?? 0) + 1);
  }

  const finalCounts = new Map<string, unknown>();
  for (const row of userCardCounts) {
    if (!row.card?.id) continue;
    finalCounts.set(row.card.id, row.count);
  }

  return { drawnCounts, finalCounts };
}

function collectNewCardNamesForCurrentDraw(
  drawnCards: GachaCard[],
  drawnCounts: Map<string, number>,
  finalCounts: Map<string, unknown>,
): string[] {
  const seenInCurrentDraw = new Set<string>();
  const newCardNames: string[] = [];

  for (const drawnCard of drawnCards) {
    if (seenInCurrentDraw.has(drawnCard.id)) continue;

    const rawFinalCount = finalCounts.get(drawnCard.id);
    if (rawFinalCount === undefined) {
      seenInCurrentDraw.add(drawnCard.id);
      continue;
    }

    // 既存 {newCards}/{newCardCount} は従来から Number(value) || 0 で縮退している。
    // 新placeholderの厳密判定は呼び出し前に済ませ、ここは後方互換の算出だけを担う。
    const finalCount = Number(rawFinalCount) || 0;
    const currentDrawCount = drawnCounts.get(drawnCard.id) ?? 0;
    const previousCount = finalCount - currentDrawCount;
    // 所持数の取得に失敗して finalCount=0 へ縮退すると、previousCount が負値になって
    // 「初出」誤通知が発生し得る。
    // 「初出」と判定するには「いま実際に所持している（finalCount > 0）」必要がある。
    // If the count lookup falls back to zero, finalCount can be below currentDrawCount,
    // making previousCount negative. Treat as "new card" only when the user actually owns it.
    if (finalCount > 0 && previousCount <= 0) {
      newCardNames.push(drawnCard.name);
    }
    seenInCurrentDraw.add(drawnCard.id);
  }

  return newCardNames;
}

export function findNewCardNamesForCurrentDraw(
  drawnCards: GachaCard[],
  userCardCounts: UserCardCountRow[],
): string[] {
  const { drawnCounts, finalCounts } = buildCurrentDrawCountMaps(drawnCards, userCardCounts);
  return collectNewCardNamesForCurrentDraw(drawnCards, drawnCounts, finalCounts);
}

/**
 * 初入手名一覧を安全に解決する。`findNewCardNamesForCurrentDraw` の既存仕様は、行欠落時に
 * 「初入手ではない」とみなして空配列を返すため、既存 {newCards} の互換出力には適している。
 * しかし {newCardsOrNone} の「なし」は、全当選カードについて今回の抽選回数以上の最終所持数を
 * 確認できた場合だけ出してよい。行欠落・0・不正な値はDB/RPCの部分応答の可能性があり、空配列と
 * 同一視すると「判定不能」を「初入手なし」と誤通知するため undefined を返して区別する。
 */
function resolveNewCardNamesForCurrentDraw(
  drawnCards: GachaCard[],
  userCardCounts: UserCardCountRow[],
): string[] | undefined {
  const { drawnCounts, finalCounts } = buildCurrentDrawCountMaps(drawnCards, userCardCounts);

  for (const [cardId, currentDrawCount] of drawnCounts) {
    const finalCount = finalCounts.get(cardId);
    if (
      typeof finalCount !== 'number'
      || !Number.isInteger(finalCount)
      || finalCount < currentDrawCount
    ) {
      return undefined;
    }
  }

  return collectNewCardNamesForCurrentDraw(drawnCards, drawnCounts, finalCounts);
}

export async function handleRaidNotification(messageId: string, event: {
  from_broadcaster_user_id?: string;
  from_broadcaster_user_login?: string;
  from_broadcaster_user_name?: string;
  to_broadcaster_user_id?: string;
  to_broadcaster_user_login?: string;
  to_broadcaster_user_name?: string;
  viewers?: number;
}): Promise<RedemptionOutcome> {
  const toBroadcasterUserId = event.to_broadcaster_user_id;
  const fromBroadcasterUserId = event.from_broadcaster_user_id;
  if (!toBroadcasterUserId || !fromBroadcasterUserId) {
    logger.warn("[EventSub] Raid notification missing broadcaster id", { messageId, event });
    // payload自体が壊れている（データ欠落）ため再試行しても解決しない
    // The payload itself is malformed (missing data) - retrying won't help
    return { notify: null, retryable: false };
  }

  const gachaService = new GachaService();
  const result = await gachaService.executeGachaForRaidEvent({
    to_broadcaster_user_id: toBroadcasterUserId,
    from_broadcaster_user_id: fromBroadcasterUserId,
    from_broadcaster_user_login: event.from_broadcaster_user_login,
    from_broadcaster_user_name: event.from_broadcaster_user_name,
  }, messageId);

  if (!result.success) {
    if (result.error === 'Raid gacha disabled') {
      logger.info("[EventSub] Raid gacha gift skipped because it is disabled", {
        messageId,
        toBroadcasterUserId,
        fromBroadcasterUserId,
      });
      return { notify: null, retryable: false };
    }
    if (result.error === 'Duplicate event') {
      logger.info("[EventSub] Raid gacha gift skipped - duplicate event", { messageId });
      return { notify: null, retryable: false };
    }
    if (result.error === 'No cards available for this streamer') {
      logger.warn("[EventSub] Raid gacha gift skipped - no cards available", {
        messageId,
        toBroadcasterUserId,
      });
      return { notify: null, retryable: false };
    }
    // Issue #787: 上記のいずれにも一致しない失敗は、既知の確定的な終端理由
    // ではなく DB一時障害・ネットワークタイムアウト等の予期しない失敗
    // （executeGachaForRaidEvent 内の catch で `Unexpected error: ...` に
    // 変換されたものを含む）である可能性がある。retryable: true とし、
    // リプレイ経路（eventsub-replay/route.ts）ではKVエントリを削除せず
    // 再試行対象として残す。
    await reportError(new Error(`Raid gacha gift failed: ${result.error}`), {
      context: "eventsub:handleRaidNotification",
      messageId,
      toBroadcasterUserId,
      fromBroadcasterUserId,
      gachaError: result.error,
    });
    return { notify: null, retryable: true };
  }

  const streamer = result.data.streamer;
  if (!streamer) {
    logger.warn("[EventSub] Raid gacha gift missing streamer info", { messageId });
    // 成功結果なのにstreamer情報が欠落する想定外のデータ不整合。
    // Unexpected data inconsistency: success result but missing streamer info.
    return { notify: null, retryable: true };
  }

  logger.info("[EventSub] Raid gacha gift succeeded", {
    messageId,
    streamerId: streamer.id,
    toBroadcasterUserId,
    fromBroadcasterUserId,
    viewers: event.viewers,
    drawCount: result.data.cards?.length ?? 1,
  });

  return {
    notify: {
      gachaResult: {
        type: "gacha",
        card: result.data.card,
        cards: result.data.cards,
        userTwitchUsername: result.data.userTwitchUsername,
      },
      broadcasterTwitchUserId: toBroadcasterUserId,
      streamer,
      userId: fromBroadcasterUserId,
      batchId: messageId,
    },
    retryable: false,
  };
}

/** postRedemptionNotify に渡すデータ（streamer.id を streamerId として再利用し冗長を排除） */
export interface RedemptionNotifyData {
  gachaResult: {
    type: "gacha";
    card: GachaCard;
    cards?: GachaCard[];
    userTwitchUsername: string;
    rewardId?: string | null;
    // Issue #597: {packName} プレースホルダ解決用。抽選がパックに絞られて
    // いない場合(無制限ガチャ、raid gacha 等)は null/undefined。
    collectionName?: string | null;
  };
  broadcasterTwitchUserId: string;
  streamer: EventSubStreamerInfo;
  userId: string;
  /** gacha_history.event_id の1枚目と一致するEventSub message ID。 */
  batchId: string;
  /**
   * ガチャcommit時点の所有数系placeholder。outbox relayは再送時に現在値を
   * 再問合せせず、このsnapshotから毎回同じ本文を生成する。
   */
  chatSnapshot?: ChatAnnouncementSnapshot;
}

export interface ChatAnnouncementSnapshot {
  cardCount: number;
  uniqueCount: number;
  allCount: number;
  newCardNames: string[];
  /**
   * 全当選カードの最終所持数を確認できた場合だけtrue。payload v1へ後方互換に追加するため
   * optionalとし、fieldが無い移行前outbox行は「判定不能」としてfail-closedに扱う。
   */
  newCardNamesResolved?: boolean;
}

/**
 * handleRedemption/handleRaidNotification の戻り値（Issue #787）。
 *
 * notify: 成功時の通知データ（nullなら通知不要）。
 * retryable: true の場合、DB一時障害等の予期しない失敗であり、呼び出し元は
 *   再試行すべき（リプレイ経路ではKVエントリを残す）。false の場合は
 *   重複/報酬不一致/カード無し/売り切れ/配信者未登録等の確定的な終端結果で、
 *   再試行しても結果は変わらない（リプレイ経路ではKVエントリを削除してよい）。
 *   ライブ経路（route.ts）はこのフィールドを参照しない（常に2xxを返す設計のため
 *   意味を持たないが、型の一貫性のため両関数とも必ず設定する）。
 *
 * 背景: 以前は成功時に通知データを、失敗時は理由を問わず一律 null を返していた。
 * リプレイ経路（eventsub-replay/route.ts）はこの null を「正当な終端結果」と
 * みなしてKVエントリを削除していたため、DB一時障害等の再試行すべき失敗まで
 * 永久にKVから消えてしまい、リプレイ機構の目的（メンテ中に失われたガチャ交換の
 * 救済）を損なうバグがあった。retryable フィールドでこの2種類を区別する。
 */
export interface RedemptionOutcome {
  notify: RedemptionNotifyData | null;
  retryable: boolean;
}

/**
 * ガチャ結果確定後の通知処理（ブロードキャスト + チャット通知）
 * waitUntil() でレスポンス返却後にバックグラウンド実行される。
 * broadcastとchatは独立しているためPromise.allSettledで並列実行する。
 *
 * Post-redemption notifications (broadcast + chat) run after response via waitUntil().
 * broadcast and chat are independent, so execute in parallel with Promise.allSettled.
 */
export async function postRedemptionNotify(
  data: RedemptionNotifyData,
  options: { externalSendDeadlineAt?: number } = {},
): Promise<void> {
  const chatTask = (async () => {
    // chat無効時はexecute_gacha_transactionもoutboxを作らないためDB操作ゼロ。
    if (!data.streamer.chat_announcement_enabled) return;

    // outbox行はカード付与と同じDB transactionで既にcommit済み。ここでは短い
    // owner-fenced claimだけを取得し、Cron/手動relayとの通常の二重送信を防ぐ。
    const claim = await claimChatNotificationBatch(data.batchId);
    if (!claim) return;

    let deliveryStatePersisted = false;
    try {
      // DBにcommitされたversioned payloadを正本にする。メモリ上のdataはN連の
      // 部分再開時に今回分しか含まない可能性があるため、claim後の配送には使わない。
      const persistedData = decodeChatNotificationPayload(claim);
      if (!persistedData) {
        const persisted = await deadLetterChatNotification(
          claim,
          `transactional chat outbox payload v${claim.payloadVersion} is invalid`,
        );
        deliveryStatePersisted = true;
        throw new Error(
          persisted
            ? 'Chat announcement payload moved to DLQ'
            : 'Chat announcement payload DLQ update lost its lease',
        );
      }
      const outcome = await sendChatAnnouncement(
        persistedData.broadcasterTwitchUserId,
        persistedData.streamer,
        persistedData.gachaResult.card,
        persistedData.gachaResult.userTwitchUsername,
        persistedData.userId,
        persistedData.gachaResult.cards,
        persistedData.gachaResult.collectionName,
        persistedData.chatSnapshot,
        async () => {
          // replay routeが期限切れで応答を返した後に、遅れて資格情報解決が完了しても
          // Twitch送信を開始しない。期限内ならowner-fenced lease更新を最終送信許可にする。
          if (
            options.externalSendDeadlineAt !== undefined
            && Date.now() >= options.externalSendDeadlineAt
          ) {
            return false;
          }
          const renewed = await renewChatNotificationLease(claim);
          // renewのDB接続待ち中に開始期限を跨いだ場合も、外部送信は開始しない。
          return renewed && (
            options.externalSendDeadlineAt === undefined
            || Date.now() < options.externalSendDeadlineAt
          );
        },
      );
      if (outcome.outcome === 'sent' || outcome.outcome === 'skipped') {
        const persisted = await markChatNotificationSent(claim);
        // Twitch送信とDB ackは同一transactionにできない。送信後にleaseを失って
        // ackできなければ別relayが再送し得るため、成功として黙殺せず通知する。
        deliveryStatePersisted = true;
        if (!persisted) {
          throw new Error('Chat announcement sent but outbox ack lost its lease');
        }
        return;
      }
      if (outcome.outcome === 'terminal') {
        const persisted = await deadLetterChatNotification(claim, outcome.reason);
        deliveryStatePersisted = true;
        if (!persisted) {
          throw new Error(`Chat announcement DLQ update lost its lease: ${outcome.reason}`);
        }
        throw new Error(`Chat announcement moved to DLQ: ${outcome.reason}`);
      }
      if (outcome.outcome === 'aborted') {
        // leaseを失った（またはfence確認不能な）所有者は、新所有者の状態を
        // pending/deadへ上書きしてはならない。現在のlease失効/新所有者へ委ねる。
        deliveryStatePersisted = true;
        throw new Error(`Chat announcement aborted: ${outcome.reason}`);
      }
      const retryState = await retryChatNotification(claim, outcome.reason);
      deliveryStatePersisted = true;
      throw new Error(`Chat announcement ${retryState}: ${outcome.reason}`);
    } catch (error) {
      // sendChatAnnouncement自体の予期しないthrowも一時障害として上限付き再試行へ戻す。
      const reason = error instanceof Error ? error.message : String(error);
      if (!deliveryStatePersisted) {
        await retryChatNotification(claim, reason);
      }
      throw error;
    }
  })();

  const results = await Promise.allSettled([
    // Realtime通知: waitUntil内でもCPU時間は有限のためリトライを1回に制限
    publishCommittedGachaBatch(data.streamer.id, data.gachaResult, {
      batchId: data.batchId,
      maxRetries: 1,
      retryDelay: 500,
    }),
    chatTask,
  ]);

  // 通知失敗をログ出力 + エラー追跡
  // Note: publishCommittedGachaBatch (i=0) は失敗を結果へ閉じ込め、polling回収へ
  // 委ねる設計のため rejected にならない。詳細はpublisher側の構造化warnで追跡する。
  // chatAnnouncement (i=1) は引き続きエラー時に throw するため、こちらのみ reportError が機能する
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const label = i === 0 ? 'broadcast' : 'chatAnnouncement';
      logger.warn(`[postRedemptionNotify] ${label} failed`, {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        streamerId: data.streamer.id,
      });
      await reportNotificationError(result.reason, {
        context: `eventsub:postRedemptionNotify:${label}`,
        streamerId: data.streamer.id,
        broadcasterTwitchUserId: data.broadcasterTwitchUserId,
      });
    }
  }
}

/** postSoldOutNotify に渡すデータ（Issue #544/#546） */
export interface SoldOutNotifyData {
  broadcasterTwitchUserId: string;
  userName: string;
  rewardId: string;
  /** EventSub payload の event.id（redemption ID）。無い場合は返還を試みない */
  redemptionId?: string;
}

/**
 * 売り切れ(発行枚数上限到達)確定後の通知処理（チャンネルポイント返還 + チャット通知）。
 * waitUntil() でレスポンス返却後にバックグラウンド実行される。
 *
 * Issue #546: redemptionId がある場合のみチャンネルポイント返還(CANCELED更新)を試みる。
 * 返還APIの失敗はログ + reportError するのみで、例外を伝播させない
 * （ガチャ自体は既に失敗しているため、この救済処理の失敗でEventSubレスポンスを悪化させない）。
 *
 * Issue #544: 返還の成否に応じてメッセージ文言を変え、chat_announcement_enabled が
 * 有効な配信者にのみチャット通知する。ガチャ成功時と同じ設定フラグを再利用し、
 * 売り切れ通知専用のON/OFF設定は追加しない（Issue #544 の実装プラン通り）。
 *
 * Post sold-out notifications (channel points refund + chat announcement) run after
 * response via waitUntil(). A refund failure is logged/reported but never thrown —
 * the gacha draw has already failed, so a refund-API failure must not cascade into a
 * worse response to Twitch's EventSub webhook.
 */
export async function postSoldOutNotify(data: SoldOutNotifyData): Promise<void> {
  const { broadcasterTwitchUserId, userName, rewardId, redemptionId } = data;
  let refunded = false;

  if (redemptionId) {
    try {
      const result = await cancelRedemption({ broadcasterTwitchUserId, rewardId, redemptionId });
      refunded = result.success;

      if (result.success) {
        logger.info('[postSoldOutNotify] Channel points refunded', {
          broadcasterTwitchUserId,
          rewardId,
          redemptionId,
        });
      } else {
        logger.warn('[postSoldOutNotify] Failed to refund channel points', {
          broadcasterTwitchUserId,
          rewardId,
          redemptionId,
          reason: result.reason,
        });
        await reportNotificationError(new Error(`cancelRedemption failed: ${result.reason ?? 'unknown'}`), {
          context: 'eventsub:postSoldOutNotify:cancelRedemption',
          broadcasterTwitchUserId,
          rewardId,
          redemptionId,
        });
      }
    } catch (error) {
      // cancelRedemption 自体は例外を投げない設計だが、念のため二重に防御する。
      // cancelRedemption never throws by design, but defend defensively anyway.
      logger.error('[postSoldOutNotify] cancelRedemption threw unexpectedly', {
        broadcasterTwitchUserId,
        rewardId,
        redemptionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await reportNotificationError(error, {
        context: 'eventsub:postSoldOutNotify:cancelRedemption',
        broadcasterTwitchUserId,
        rewardId,
        redemptionId,
      });
    }
  } else {
    // EventSubのサブスクリプション種別によっては redemption id が payload に
    // 含まれない可能性があるため、その場合は返還を試みずチャット通知のみ行う。
    logger.info('[postSoldOutNotify] No redemption id available - skipping refund attempt', {
      broadcasterTwitchUserId,
      rewardId,
    });
  }

  try {
    let streamer: { chat_announcement_enabled: boolean } | null = null;
    try {
      // Sold-out redemptionも成功時と同じpost-commit境界で扱う。設定読取を
      // PlanetScaleへ固定し、退役済みSupabase経路がポイント返還通知を壊さないようにする。
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select({ chat_announcement_enabled: streamersTable.chat_announcement_enabled })
            .from(streamersTable)
            .where(eq(streamersTable.twitch_user_id, broadcasterTwitchUserId))
            .limit(1);
        },
        "eventsub:postSoldOutNotify:streamer",
        { idempotent: true },
      );
      streamer = rows[0] ?? null;
    } catch (error) {
      logger.warn('[postSoldOutNotify] Failed to fetch chat announcement settings', {
        broadcasterTwitchUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      // ポイント返還は既に試行済みなので、監視保存の失敗でWebhook retry stormを
      // 起こさない。schema/接続障害をbest-effortで記録し、チャットだけ省略する。
      await reportNotificationError(error, {
        context: 'eventsub:postSoldOutNotify:streamerSettings',
        broadcasterTwitchUserId,
      });
      return;
    }

    if (!streamer?.chat_announcement_enabled) {
      logger.info('[postSoldOutNotify] Chat announcement skipped - feature disabled', {
        broadcasterTwitchUserId,
      });
      return;
    }

    const message = `@${userName} ${SOLD_OUT_CHAT_MESSAGE}${refunded ? SOLD_OUT_CHAT_MESSAGE_REFUNDED_SUFFIX : ''}`;
    const chatService = new TwitchChatService();
    const success = await chatService.sendChatMessage(broadcasterTwitchUserId, message);

    if (success) {
      logger.info('[postSoldOutNotify] Sold-out chat announcement sent', { broadcasterTwitchUserId, refunded });
    } else {
      logger.warn('[postSoldOutNotify] Sold-out chat announcement failed', { broadcasterTwitchUserId, refunded });
    }
  } catch (error) {
    logger.warn('[postSoldOutNotify] Chat announcement threw unexpectedly', {
      broadcasterTwitchUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    await reportNotificationError(error, {
      context: 'eventsub:postSoldOutNotify:chatAnnouncement',
      broadcasterTwitchUserId,
    });
  }
}

/**
 * ガチャ実行とデータ準備を行い、通知に必要なデータを返す。
 * 通知処理自体は呼び出し元で waitUntil() により遅延実行される。
 *
 * Execute gacha and prepare data for notifications.
 * Actual notification is deferred by caller via waitUntil().
 *
 * @returns RedemptionOutcome（notify: 通知不要な場合はnull / retryable: 詳細は型定義参照）
 */
export async function handleRedemption(messageId: string, event: {
  id?: string;
  broadcaster_user_id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  reward: { id: string; title: string; cost?: number };
}): Promise<RedemptionOutcome> {
  logger.info('[handleRedemption] START', {
    messageId,
    broadcasterUserId: event.broadcaster_user_id,
    userName: event.user_name,
    rewardTitle: event.reward.title,
  });

  // Issue #512: 以前はここで「event_id=messageId(N連の1枚目)の行が存在
  // するか」だけを見て、存在すれば必ずバッチ全体をスキップしていた。しかし
  // N連ドロー(追加報酬のdraw_count>1)がバッチ途中で失敗し、EventSub再送が
  // 残りのドローを完了させようとしても、1枚目が既に存在するというだけで
  // 再送全体をスキップしてしまい、残りのカードが永久に付与されないバグが
  // あった。完了済み件数の判定は executeGachaDraws 内の resumeFromIndex
  // 起点の再開ロジック(countCompletedDrawPrefix)に一本化したため、ここでの
  // 事前チェックは冗長になった。
  //
  // トレードオフ: このチェックはもともと「ストリーマー設定/カード構成が
  // 変わった後の再送を "Reward ID mismatch" 等の誤ったカテゴリでログ分類
  // しない」ためのものだった(レビュー指摘 P2)。削除すると、設定変更を
  // 挟んだ再送は executeGachaForEventSub を毎回最初からやり直すため、
  // 再送時点の(変更後の)設定でリワード一致判定・draw_count解決が行われる。
  // 通常の完全一致再送(設定変更なし)は countCompletedDrawPrefix が全件
  // 一致を検知して従来どおり 'Duplicate event' で静かにスキップするため
  // 影響はないが、元の処理から再送までの間に「同じreward_idのdraw_countを
  // 変更する」ような設定変更が挟まった極めて稀なケースでは、変更後のdraw_countを
  // 基準に不足分(または解釈によっては超過分)が再試行されうる。
  // gacha_history には各ドローが event_id 付きで確定記録されるため事後に
  // 監査可能であり、無限に増幅する類の不整合ではないこと、また
  // このチェックを残したままだと上記の「再送が永久にスキップされる」
  // バグを再発させてしまうことから、この限定的なリスクは許容する。
  try {
    const gachaService = new GachaService();
    const result = await gachaService.executeGachaForEventSub(event, messageId);

    if (!result.success) {
      // EventSub重複通知は正常系（リトライによる再送）なのでエラー報告しない
      // Duplicate event is expected (EventSub retry) - don't report as error
      if (result.error === 'Duplicate event') {
        logger.info('[handleRedemption] Skipped - duplicate event (RPC)', { messageId });
        return { notify: null, retryable: false };
      }
      // 設定から外れた報酬の古い EventSub 通知は運用状態のズレであり、
      // production error としてGitHub Issue化しない。
      if (result.error === 'Reward ID mismatch') {
        logger.warn('[handleRedemption] Reward ID mismatch - stale or unconfigured EventSub notification', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
          rewardId: event.reward.id,
        });
        return { notify: null, retryable: false };
      }
      if (result.error === 'Raid-limited reward inactive') {
        logger.info('[handleRedemption] Raid-limited reward skipped outside active raid window', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
          rewardId: event.reward.id,
        });
        return { notify: null, retryable: false };
      }
      // カード未設定はユーザー設定の問題でありバグではない (Issue #277)
      // "No cards available" is a streamer setup issue, not a system bug
      if (result.error === 'No cards available for this streamer') {
        logger.warn('[handleRedemption] No cards available - streamer setup issue', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
        });
        return { notify: null, retryable: false };
      }
      // カード発行可能枚数の上限到達（本物のsoldOut）、または必須RPC未デプロイを
      // fail-closedにした結果(limitUnavailable、#594)。
      // どちらの場合も視聴者は既にチャンネルポイントを消費済みでカードを
      // 受け取れていないため、Issue #544/#546 の返還・チャット通知は両方の
      // ケースで実施する。一方 limitUnavailable は「RPCが本来存在すべきなのに
      // 存在しない」という異常系(#594で意図的に soldOut と別メッセージに
      // 分離した)なので、こちらは通常のsoldOutと違い reportError で運用に
      // 通知する(視聴者救済と運用アラートは独立した関心事のため両方行う)。
      //
      // Card issuance limit reached (soldOut) is the result of streamer
      // configuration, not a system bug — no reportError. limitUnavailable
      // means the RPC is unexpectedly missing (see #594) — still refund/notify
      // the viewer (they already spent points), but ALSO reportError since an
      // unexpectedly-missing RPC is an operational issue that needs attention.
      if (
        result.error === CARD_ISSUANCE_MESSAGES.soldOut ||
        result.error === CARD_ISSUANCE_MESSAGES.limitUnavailable
      ) {
        const isUnexpectedRpcMissing = result.error === CARD_ISSUANCE_MESSAGES.limitUnavailable;

        logger.warn('[handleRedemption] Card issuance limit reached', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
          gachaError: result.error,
          isUnexpectedRpcMissing,
        });

        if (isUnexpectedRpcMissing) {
          await reportError(new Error(`Gacha execution failed (RPC unexpectedly missing): ${result.error}`), {
            context: 'eventsub:handleRedemption:limitUnavailable',
            messageId,
            broadcasterUserId: event.broadcaster_user_id,
          });
        }

        // Issue #544/#546: 視聴者はチャンネルポイントを消費済みなので、
        // ポイント返還を試み、結果に応じたチャット通知を送る。
        // 通知処理自体はレスポンスをブロックしないよう waitUntil() で遅延実行する
        // （ガチャ成功時の postRedemptionNotify と同じパターン）。
        await runInBackground('soldOut notification', postSoldOutNotify({
          broadcasterTwitchUserId: event.broadcaster_user_id,
          userName: event.user_name,
          rewardId: event.reward.id,
          redemptionId: event.id,
        }));
        // 返還処理まで完了済みの確定的な終端結果（再試行しても結果は変わらない）
        return { notify: null, retryable: false };
      }

      // 削除済み/未登録 broadcaster の古い EventSub 通知は設定起因であり、
      // production error としてGitHub Issue化しない。
      if (result.error === 'Streamer not found') {
        logger.warn('[handleRedemption] Streamer not found - stale or unconfigured EventSub notification', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
        });
        return { notify: null, retryable: false };
      }
      // Issue #787: 上記いずれの既知理由にも一致しない失敗
      // （executeGachaForEventSub 内部の catch で `Unexpected error: ...` に
      // 変換された DB一時障害・ネットワークタイムアウト等を含む）。
      // retryable: true とし、リプレイ経路ではKVエントリを削除せず
      // 再試行対象として残す（このバグ修正の核心部分）。
      logger.warn('[handleRedemption] Gacha execution failed', { messageId });
      await reportError(new Error(`Gacha execution failed: ${result.error}`), {
        context: 'eventsub:handleRedemption',
        messageId,
        broadcasterUserId: event.broadcaster_user_id,
        gachaError: result.error,
      });
      return { notify: null, retryable: true };
    }

    logger.info('[handleRedemption] Gacha success', {
      messageId,
      cardName: result.data.card.name,
    });

    // ストリーマー情報は executeGachaForEventSub のクエリ統合で取得済み
    // Streamer info already fetched in the unified query within executeGachaForEventSub
    const streamer = result.data.streamer;
    if (!streamer) {
      logger.warn('[handleRedemption] No streamer info in gacha result', { messageId });
      // 成功結果なのにstreamer情報が欠落する想定外のデータ不整合。
      // Unexpected data inconsistency: success result but missing streamer info.
      return { notify: null, retryable: true };
    }

    const gachaResult = {
      type: "gacha" as const,
      card: result.data.card,
      cards: result.data.cards,
      userTwitchUsername: result.data.userTwitchUsername,
      rewardId: result.data.rewardId ?? event.reward.id,
      collectionName: result.data.collectionName ?? null,
    };

    logger.info('[handleRedemption] END', { messageId });

    return {
      notify: {
        gachaResult,
        broadcasterTwitchUserId: event.broadcaster_user_id,
        streamer,
        userId: event.user_id,
        batchId: messageId,
      },
      retryable: false,
    };
  } catch (error) {
    // awaitしないとCloudflare Workersがレスポンス返却後にPromiseを打ち切り、
    // PlanetScaleへのエラー記録が失われる
    await handleApiError(error, `EventSub redemption (messageId=${messageId})`);
    // 予期しない例外を握りつぶした結果のため、再試行価値ありとして扱う。
    // Unexpected exception was swallowed here - treat as retryable.
    return { notify: null, retryable: true };
  }
}

/**
 * sendChatAnnouncement の {num}/{unique}/{newCards} 用 get_user_card_counts RPC の
 * pg 直結(postgres.js)実装 (#573/#803)。EventSub成功後の通知経路も
 * PlanetScaleへ固定し、退役Supabase clientや旧driver secretに依存しない。
 *
 * { data, error } 形状へ正規化し、呼び出し側でDB障害時もプレースホルダを
 * 空文字化してチャット本文自体は送れるようにする。
 *
 * キャッシュ非依存性: pg直結はHTTP cacheを介さず毎回PostgreSQLへ問い合わせる
 * ため、直前のガチャで増えた所持数を常に最新状態から読む。
 *
 * エラー処理: 42883を含む全DBエラーを { data: null, error } へ正規化し、
 * 呼び出し側がerrorsテーブルへ記録してからカウント無しで通知を継続する。
 *
 * migration 00031: RETURNS JSONB（{ count, card, streamer } の行配列）。スカラー
 * SELECT + rows[0].result で PostgREST .rpc() の data と同一形状になる（jsonb →
 * JS 値変換の根拠は gacha.ts executeGachaTransactionRpcPg の doc コメント参照）。
 * 名前付き引数 + uuid 明示キャストも gacha.ts と同じ規約。読み取り専用のため
 * 冪等としてリトライを opt-in する（バックオフは既存 withRetry と同じ既定値）。
 */
export async function fetchUserCardCountsRpcPg(
  userId: string,
  streamerId: string
): Promise<{ data: unknown; error: { message: string } | null }> {
  try {
    const data = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { sql } = await getDb();
        const rows = await sql<{ result: unknown }[]>`
          select get_user_card_counts(
            p_twitch_user_id => ${userId},
            p_streamer_id => ${streamerId}::uuid
          ) as result
        `;
        return rows[0]?.result ?? null;
      },
      "eventsub:sendChatAnnouncement:userCardCounts(pg)",
      { idempotent: true },
    );
    return { data, error: null };
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * チャット通知の `{all}` 用にPlanetScale上のアクティブカード総数を取得する。
 * 通知はガチャ確定後の処理なので、読取失敗はerror値へ正規化し、カード付与や
 * EventSub応答を巻き戻さない。接続取得をretry callback内に置くことで、
 * request scope破棄後の一時切断だけをbounded retryする。
 */
async function fetchActiveCardCountPg(
  streamerId: string,
): Promise<{ count: number | null; error: { message: string } | null }> {
  try {
    const count = await withDbRetry(
      async () => {
        const { sql } = await getDb();
        const rows = await sql<{ count: number }[]>`
          select count(*)::integer as count
          from cards
          where streamer_id = ${streamerId}::uuid
            and is_active = true
        `;
        return rows[0]?.count ?? 0;
      },
      "eventsub:sendChatAnnouncement:activeCardCount",
      { idempotent: true },
    );
    return { count, error: null };
  } catch (error) {
    return {
      count: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * チャット通知を送信する
 * Send chat announcement for gacha result
 *
 * @param broadcasterTwitchUserId - 配信者のTwitchユーザーID
 * @param streamer - 配信者の設定情報
 * @param card - 獲得したカード（GachaCard型 - gacha serviceから返される）
 * @param userName - ガチャを引いたユーザー名
 * @param userId - ガチャを引いたユーザーのTwitch ID
 * @param cards - 複数枚ガチャ時の獲得カード一覧
 * @param collectionName - 抽選が絞られたパックの collection_name（無制限ガチャは null/undefined、Issue #597）
 * @param snapshot - ガチャcommit時点の所有数系placeholder（outbox v1では必須）
 * @param beforeExternalSend - 資格情報解決後・Twitch送信直前に行うowner fence
 */
export type ChatAnnouncementOutcome =
  | { outcome: 'sent' }
  | { outcome: 'skipped' }
  | { outcome: 'terminal'; reason: string }
  | { outcome: 'retryable'; reason: string }
  | { outcome: 'aborted'; reason: string };

export async function sendChatAnnouncement(
  broadcasterTwitchUserId: string,
  streamer: {
    id: string;
    chat_announcement_enabled: boolean;
    chat_announcement_template: string | null;
    chat_announcement_multi_template: string | null;
    chat_announcement_multi_show_cards: boolean;
    default_card_pack_name?: string | null;
  },
  card: GachaCard,
  userName: string,
  userId: string,
  cards?: GachaCard[],
  collectionName?: string | null,
  snapshot?: ChatAnnouncementSnapshot,
  beforeExternalSend?: () => Promise<boolean>,
): Promise<ChatAnnouncementOutcome> {
  const drawnCards = cards && cards.length > 0 ? cards : [card];
  const isMultiDraw = drawnCards.length > 1;
  const cardNames = drawnCards.map((drawnCard) => drawnCard.name);
  const rarityCounts = formatRarityCountsForChat(drawnCards.map((drawnCard) => drawnCard.rarity));

  // 関数呼び出しを記録（デバッグ用：この関数が呼ばれたことを確認するため）
  // Log function entry to confirm this function is being called
  logger.info('sendChatAnnouncement called', {
    broadcasterTwitchUserId,
    streamerId: streamer.id,
    chatAnnouncementEnabled: streamer.chat_announcement_enabled,
    cardName: card.name,
    drawCount: drawnCards.length,
    userName,
  });

  // チャット通知が無効の場合はスキップ
  // Skip if chat announcement is disabled
  if (!streamer.chat_announcement_enabled) {
    // 無効状態を明示的にログ出力（以前は無言リターンでデバッグ困難だった）
    // Explicitly log disabled state (previously returned silently, making debugging impossible)
    logger.info('Chat announcement skipped - feature disabled', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
    });
    return { outcome: 'skipped' };
  }

  // レアリティの日本語/英語変換マップ
  // Rarity translation map
  const rarityMap: Record<string, string> = {
    common: 'コモン',
    rare: 'レア',
    epic: 'エピック',
    legendary: 'レジェンダリー',
  };

  // テンプレートに含まれるプレースホルダーに応じてのみDBクエリを実行
  // waitUntil内のwall time短縮のため、不要なDBクエリをスキップ
  // Run DB queries only for placeholders that appear in the template to keep waitUntil wall-time short
  const messageTemplate = isMultiDraw
    ? streamer.chat_announcement_multi_template || DEFAULT_MULTI_DRAW_CHAT_TEMPLATE
    : streamer.chat_announcement_template || DEFAULT_CHAT_TEMPLATE;
  const usesMultiDrawPlaceholders = /\{cards\}|\{draws\}|\{rarityCounts\}|\{newCards\}|\{newCardCount\}|\{newCardsOrNone\}/.test(messageTemplate);
  const effectiveTemplate = messageTemplate;
  const needsCardCount = /\{num\}/.test(effectiveTemplate);
  const needsUniqueCount = /\{unique\}/.test(effectiveTemplate);
  const needsAllCount = /\{all\}/.test(effectiveTemplate);
  const usesNewCardPlaceholders = /\{newCards\}|\{newCardCount\}|\{newCardsOrNone\}/.test(effectiveTemplate);
  const shouldAppendDefaultNewCards = isMultiDraw
    && streamer.chat_announcement_multi_show_cards
    && !streamer.chat_announcement_multi_template;
  const needsNewCardInfo = isMultiDraw
    && streamer.chat_announcement_multi_show_cards
    && (usesNewCardPlaceholders || shouldAppendDefaultNewCards);

  let cardCount: number | undefined = snapshot?.cardCount;
  let uniqueCount: number | undefined = snapshot?.uniqueCount;
  let allCount: number | undefined = snapshot?.allCount;
  let newCardNames: string[] = snapshot?.newCardNames ?? [];
  // `newCardNames` 自体は既存 {newCards}/{newCardCount} の後方互換のため、従来どおり
  // 失敗時にも空配列へフォールバックする。一方で空配列だけでは「正常に0件」と
  // 「取得不能」を区別できず、後者で {newCardsOrNone} を「なし」と誤通知してしまう。
  // そこで判定成否を別フラグに保持し、新placeholderだけがこの明示状態を見る。
  // snapshotの存在だけでは、SQL集約時に当選カードの所持行が欠落していないことを保証できない。
  // DBが明示的に完全性を検証した新fieldだけを信頼し、移行前payloadは空文字へfail-closedにする。
  let newCardInfoResolved = snapshot?.newCardNamesResolved === true;

  if (!snapshot && (needsCardCount || needsUniqueCount || needsAllCount || needsNewCardInfo)) {
    // {all} は配信者のアクティブカード総数のため、直接 cards テーブルを count クエリ
    // {all}: count active cards for this streamer (user-independent)
    const allCountPromise = needsAllCount
      ? fetchActiveCardCountPg(streamer.id)
      : null;

    // {num} / {unique} は RPC `get_user_card_counts` で DB 側 GROUP BY 済みの
    // ユーザー所持カード一覧を取得して求める（DB側集約で固定行数制限を回避）
    // is_active フィルタは RPC が行わないため、ここでは JS 側で行う
    // {num} / {unique}: use RPC returning pre-aggregated per-card counts.
    // The RPC handles GROUP BY server-side, avoiding client-side row caps.
    // RPC does not filter by is_active, so we filter on the client.
    //
    // Supabase admin clientは削除済みなので、環境に残る旧driver secretを参照せず
    // 直前のガチャ確定と同じPlanetScaleから最新の所持数を読む。
    const userCardCountsPromise = (needsCardCount || needsUniqueCount || needsNewCardInfo)
      ? fetchUserCardCountsRpcPg(userId, streamer.id)
      : null;

    // transient な transport / runtime 例外が throw されるとチャット通知全体が
    // 飛んでしまうため、Promise.all を try/catch で囲みフォールバック挙動を担保する。
    // 正規化済みの `error` payload は下の if で個別にハンドリングする。
    // Wrap the Promise.all so transient transport/runtime rejections don't abort
    // the whole chat announcement. Normalized DB error payloads are handled below.
    try {
      const [allCountResult, userCardCountsResult] = await Promise.all([
        allCountPromise,
        userCardCountsPromise,
      ]);

      if (needsAllCount) {
        if (allCountResult?.error) {
          logger.warn('Failed to fetch {all} card count for chat announcement', {
            streamerId: streamer.id,
            error: allCountResult.error.message,
          });
          await reportNotificationError(new Error(allCountResult.error.message), {
            context: 'eventsub:sendChatAnnouncement:activeCardCount',
            streamerId: streamer.id,
          });
        } else {
          allCount = allCountResult?.count ?? 0;
        }
      }

      if (needsCardCount || needsUniqueCount || needsNewCardInfo) {
        if (userCardCountsResult?.error) {
          logger.warn('Failed to fetch user card counts for chat announcement', {
            streamerId: streamer.id,
            userTwitchId: userId,
            error: userCardCountsResult.error.message,
          });
          await reportNotificationError(new Error(userCardCountsResult.error.message), {
            context: 'eventsub:sendChatAnnouncement:userCardCounts',
            streamerId: streamer.id,
          });
          if (needsUniqueCount || needsNewCardInfo) {
            // RPC 失敗時は 0 にフォールバックせず、未定義のままプレースホルダを空文字化
            // On RPC failure, leave placeholders undefined so buildMessage strips them
          }
        } else {
          // RPC は JSONB 配列を返し、各要素は { count, card: {..., is_active, id}, streamer }
          // RPC returns a JSONB array; each row holds { count, card: {...}, streamer }
          const rows = (userCardCountsResult?.data ?? []) as Array<{
            count: number;
            card: { id: string; is_active: boolean };
          }>;

          if (needsCardCount) {
            // 現在当選したカードの所持数を検索
            // Find the count for the card that just dropped
            const currentCardRow = rows.find((row) => row.card?.id === card.id);
            cardCount = currentCardRow?.count ?? 0;
          }

          if (needsUniqueCount) {
            // アクティブカードのみ数えてコンプ進捗を算出
            // Count only active cards to match the progress definition in dashboard UI
            uniqueCount = rows.filter((row) => row.card?.is_active === true).length;
          }

          // `data: null, error: null` は0件配列ではなく応答欠落として扱う。空配列だけが
          // 「正常に0件」と言えるため、Array.isArrayで確認できた場合に限り解決済みにする。
          if (needsNewCardInfo && Array.isArray(userCardCountsResult?.data)) {
            const resolvedNewCardNames = resolveNewCardNamesForCurrentDraw(drawnCards, rows);
            // 不完全な配列でも既存 {newCards}/{newCardCount} は従来の部分結果を使う。
            // 新placeholderだけは resolve 成功時に限るため、保存済みテンプレートの
            // 出力を変えずに「なし」の誤通知だけを防げる。
            newCardNames = resolvedNewCardNames ?? findNewCardNamesForCurrentDraw(drawnCards, rows);
            if (resolvedNewCardNames !== undefined) {
              newCardInfoResolved = true;
            }
          }
        }
      }
    } catch (err) {
      // transient 失敗時はプレースホルダを未定義のまま残し、通知は送信する
      // On transient failure, leave placeholders undefined and still send the announcement
      logger.warn('Chat announcement count queries threw; falling back to empty placeholders', {
        streamerId: streamer.id,
        userTwitchId: userId,
        error: err instanceof Error ? err.message : String(err),
      });
      await reportNotificationError(err, {
        context: 'eventsub:sendChatAnnouncement:countQueries',
        streamerId: streamer.id,
      });
    }
  }

  // コレクションページURLを構築
  // Build collection page URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://twica.live';
  const collectionUrl = `${baseUrl}/collection/${streamer.id}`;

  // Issue #597: {packName} 用に、抽選が絞られたパックの表示名を解決する。
  // DBクエリ不要（collectionName/default_card_pack_name は既に取得済み）のため
  // 他プレースホルダーのような needsX ガードは不要。
  // Resolve the {packName} display name. No extra DB query needed (both inputs
  // are already fetched), unlike the other placeholders gated behind needsX.
  const packName = resolvePackDisplayName(
    collectionName,
    streamer.default_card_pack_name ?? null,
    DEFAULT_PACK_CHAT_FALLBACK_LABEL
  );

  // メッセージのプレースホルダーを構築
  // Build message placeholders
  const placeholders: ChatMessagePlaceholders = {
    user: userName,
    card: card.name,
    cards: isMultiDraw && streamer.chat_announcement_multi_show_cards
      ? cardNames.join(CARD_LIST_SEPARATOR)
      : undefined,
    draws: isMultiDraw ? drawnCards.length : undefined,
    rarityCounts: isMultiDraw ? rarityCounts : undefined,
    newCards: needsNewCardInfo && newCardNames.length > 0
      ? newCardNames.join(CARD_LIST_SEPARATOR)
      : undefined,
    newCardCount: needsNewCardInfo ? newCardNames.length : undefined,
    newCardsOrNone: needsNewCardInfo && newCardInfoResolved
      ? newCardNames.length > 0
        ? newCardNames.join(CARD_LIST_SEPARATOR)
        : 'なし'
      : undefined,
    rarity: rarityMap[card.rarity] || card.rarity,
    detail: card.description || undefined,
    num: cardCount,
    unique: uniqueCount,
    all: allCount,
    url: collectionUrl,
    packName: packName || undefined,
  };

  // チャットサービスでメッセージを構築・送信
  // Build and send message using chat service
  const chatService = new TwitchChatService();
  let message: string;

  // 後段で「初出: {cardNames}」を追記する場合、{cards} 側の圧縮時に
  // 接尾辞分の文字数を予約しておかないと、最終的な truncate で「初出:」部分が
  // 切り落とされる可能性がある。事前に長さを見積もって reservedSuffixCharacters に渡す。
  // Estimate the suffix length so {cards} fitting reserves space for the appended "初出: ..."
  const willAppendDefaultNewCards = shouldAppendDefaultNewCards && newCardNames.length > 0;
  const reservedSuffixCharacters = willAppendDefaultNewCards
    ? countCharacters(' 初出: ') + countCharacters(newCardNames.join(CARD_LIST_SEPARATOR))
    : 0;

  if (isMultiDraw && streamer.chat_announcement_multi_show_cards && usesMultiDrawPlaceholders) {
    const fitted = fitCardNamesForMessage(
      cardNames,
      (cardsText) => chatService.buildMessage(messageTemplate, { ...placeholders, cards: cardsText }),
      reservedSuffixCharacters
    );
    placeholders.cards = fitted.cardsText;
    message = fitted.message;
  } else {
    const baseMessage = chatService.buildMessage(messageTemplate, placeholders);
    if (isMultiDraw && streamer.chat_announcement_multi_show_cards && !usesMultiDrawPlaceholders) {
      message = fitCardNamesForMessage(
        cardNames,
        (cardsText) => `${baseMessage}（全${drawnCards.length}枚: ${cardsText}）`,
        reservedSuffixCharacters
      ).message;
    } else {
      message = baseMessage;
    }
  }

  if (willAppendDefaultNewCards) {
    // ここでの fitCardNamesForMessage は newCardNames 側の圧縮を担う。
    // 上で {cards} 側に余白を予約済みなので、通常はここでの圧縮は発生しない。
    // The earlier pass reserved space, so this fit normally just appends as-is.
    const fitted = fitCardNamesForMessage(
      newCardNames,
      (newCardsText) => `${message} 初出: ${newCardsText}`
    );
    message = fitted.message;
  }

  // 古いテストdoubleはsendChatMessageDetailedを実装しないためbooleanへ互換変換する。
  // 本番classは必ず分類付きAPIを持ち、恒久失敗を無限再試行しない。
  const outcome = typeof chatService.sendChatMessageDetailed === 'function'
    ? beforeExternalSend
      ? await chatService.sendChatMessageDetailed(
          broadcasterTwitchUserId,
          message,
          { beforeExternalSend },
        )
      : await chatService.sendChatMessageDetailed(broadcasterTwitchUserId, message)
    : (await chatService.sendChatMessage(broadcasterTwitchUserId, message))
      ? { outcome: 'sent' as const }
      : { outcome: 'retryable' as const, reason: 'chat send failed' };

  if (outcome.outcome === 'sent') {
    logger.info('Chat announcement sent', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
      cardName: card.name,
      drawCount: drawnCards.length,
      multiDraw: isMultiDraw,
    });
  } else if (outcome.outcome === 'duplicate') {
    // Twitchの連投抑止（issue #842/#843）。障害ではないので warn を出さず、
    // 呼び出し側が outbox を ack できる 'skipped' へ写す。ここで写さないと
    // 呼び出し側の if 連鎖（sent/skipped → ack、terminal → DLQ、それ以外 → retryable）で
    // 未知の値が retryable に落ち、送れない本文を再試行し続けることになる。
    logger.info('Chat announcement suppressed as duplicate by Twitch', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
      cardName: card.name,
      drawCount: drawnCards.length,
      multiDraw: isMultiDraw,
      reason: outcome.reason,
    });
    return { outcome: 'skipped' };
  } else {
    // sendChatMessage が false を返した場合のログ（API呼び出し失敗）
    // Log when sendChatMessage returns false (API call failure)
    logger.warn('Chat announcement failed - sendChatMessage returned false', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
      cardName: card.name,
      drawCount: drawnCards.length,
      multiDraw: isMultiDraw,
    });
  }
  return outcome;
}
