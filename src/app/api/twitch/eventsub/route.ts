import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, getSupabaseAdminNoCache } from "@/lib/supabase/admin";
import { GachaService } from "@/lib/services/gacha";
import { TWITCH_SUBSCRIPTION_TYPE, ERROR_MESSAGES } from "@/lib/constants";
import { handleApiError } from "@/lib/error-handler";
import { broadcastGachaResult } from "@/lib/realtime";
import { checkRateLimit, rateLimits, getClientIp } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { reportError } from "@/lib/sentry/error-handler";
import { TwitchChatService, DEFAULT_CHAT_TEMPLATE, type ChatMessagePlaceholders } from "@/lib/twitch/chat-service";
import { hasScope } from "@/lib/twitch/token-manager";
import { ADDITIONAL_SCOPES } from "@/lib/twitch/auth";
import type { GachaCard, EventSubStreamerInfo } from "@/lib/services/gacha";

const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";

/**
 * Verify Twitch EventSub signature using HMAC-SHA256 (Web Crypto API)
 * Twitch EventSubの署名をHMAC-SHA256で検証（Web Crypto API使用）
 *
 * Web Crypto APIを使用することでCloudflare Workers/Edge Runtimeでも動作可能
 * This uses Web Crypto API for compatibility with Cloudflare Workers/Edge Runtime
 */
async function verifyTwitchSignature(
  messageId: string,
  timestamp: string,
  body: string,
  signature: string
): Promise<boolean> {
  const secret = process.env.TWITCH_EVENTSUB_SECRET;
  if (!secret || !signature) return false;

  try {
    const encoder = new TextEncoder();
    const message = messageId + timestamp + body;

    // Import the secret as an HMAC key
    // シークレットをHMACキーとしてインポート
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Generate the HMAC signature
    // HMAC署名を生成
    const messageData = encoder.encode(message);
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, messageData);
    const signatureArray = Array.from(new Uint8Array(signatureBuffer));
    const expectedSignature = 'sha256=' + signatureArray
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Constant-time comparison to prevent timing attacks
    // タイミング攻撃を防ぐための定数時間比較
    if (expectedSignature.length !== signature.length) {
      return false;
    }

    let isValid = true;
    for (let i = 0; i < expectedSignature.length; i++) {
      if (expectedSignature[i] !== signature[i]) {
        isValid = false;
        // Don't break early to maintain constant time
        // 定数時間を維持するため早期breakしない
      }
    }

    return isValid;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return handleApiError(e, "EventSub JSON parsing");
  }

  const messageId = request.headers.get("twitch-eventsub-message-id") || "";
  const timestamp = request.headers.get("twitch-eventsub-message-timestamp") || "";
  const messageType = request.headers.get("twitch-eventsub-message-type") || "";
  const signature = request.headers.get("twitch-eventsub-message-signature") || "";

  // Verify signature asynchronously (Web Crypto API is async)
  // 署名を非同期で検証（Web Crypto APIは非同期）
  if (!await verifyTwitchSignature(messageId, timestamp, body, signature)) {
    return NextResponse.json({ error: ERROR_MESSAGES.INVALID_SIGNATURE }, { status: 403 });
  }

  if (messageType !== MESSAGE_TYPE_NOTIFICATION) {
    const ip = getClientIp(request);
    const identifier = `ip:${ip}`;
    const rateLimitResult = await checkRateLimit(rateLimits.eventsub, identifier);

    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': String(rateLimitResult.remaining),
            'X-RateLimit-Reset': String(rateLimitResult.reset),
          },
        }
      );
    }
  }

  if (messageType === MESSAGE_TYPE_NOTIFICATION) {
    const subscriptionType = data.subscription.type;
    const event = data.event;

    // EventSub通知受信を記録（webhookが到達していることを確認するため）
    logger.info('[EventSub] Notification received', {
      messageId,
      subscriptionType,
      broadcasterUserId: event?.broadcaster_user_id,
    });

    if (subscriptionType === TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD) {
      // ガチャ実行のみawaitし、通知処理はwaitUntil()で遅延実行してCPU時間を削減
      // Only await gacha execution; defer notifications via waitUntil() to reduce CPU time
      const result = await handleRedemption(messageId, event);
      if (result) {
        try {
          // Cloudflare Workers の waitUntil() でレスポンス返却後にバックグラウンド実行
          const { getCloudflareContext } = await import('@opennextjs/cloudflare');
          const { ctx } = await getCloudflareContext({ async: true });
          ctx.waitUntil(postRedemptionNotify(result));
        } catch (e) {
          // ローカル開発等で getCloudflareContext が使えない場合は同期フォールバック
          // Fallback to sync execution when getCloudflareContext is unavailable (local dev)
          logger.warn('[EventSub] waitUntil unavailable, falling back to sync', {
            error: e instanceof Error ? e.message : String(e),
          });
          await postRedemptionNotify(result);
        }
      }
    }

    return NextResponse.json({ received: true });
  }

  if (messageType === MESSAGE_TYPE_VERIFICATION) {
    // Webhook検証リクエストを受信したことをログに記録
    const subscription = data.subscription;
    logger.info(
      `EventSub verification received: type=${subscription?.type}, broadcaster=${subscription?.condition?.broadcaster_user_id}`,
      { challenge: data.challenge ? "present" : "missing" }
    );

    return new NextResponse(data.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (messageType === MESSAGE_TYPE_REVOCATION) {
    // EventSubが無効化された理由をログに記録
    // Revocation reasons: authorization_revoked, user_removed, notification_failures_exceeded, version_removed
    const subscription = data.subscription;
    const revocationReason = subscription?.status || "unknown";
    const subscriptionType = subscription?.type || "unknown";
    const broadcasterId = subscription?.condition?.broadcaster_user_id || "unknown";

    // ユーザー起因のrevocationはGitHub Issue化せずログのみ (Issue #285)
    // User-initiated revocations are expected behavior, not bugs
    const EXPECTED_REVOCATIONS = ['authorization_revoked', 'user_removed'];
    if (EXPECTED_REVOCATIONS.includes(revocationReason)) {
      logger.info(
        `EventSub revocation (user-initiated): reason=${revocationReason}, type=${subscriptionType}, broadcaster=${broadcasterId}`,
        { subscription }
      );
    } else {
      // インフラ問題等の予期しないrevocationはreportErrorでGitHub Issue化
      // Unexpected revocations (e.g. notification_failures_exceeded) indicate infrastructure issues
      logger.warn(
        `EventSub revocation (unexpected): reason=${revocationReason}, type=${subscriptionType}, broadcaster=${broadcasterId}`,
        { subscription }
      );
      await reportError(new Error(`EventSub revocation: ${revocationReason}`), {
        context: "eventsub:revocation",
        type: "eventsub",
        revocationReason,
        subscriptionType,
        broadcasterId,
        subscriptionId: subscription?.id,
      });
    }

    return NextResponse.json({ received: true });
  }

  return NextResponse.json({ error: ERROR_MESSAGES.UNKNOWN_MESSAGE_TYPE }, { status: 400 });
}

/** postRedemptionNotify に渡すデータ（streamer.id を streamerId として再利用し冗長を排除） */
interface RedemptionNotifyData {
  gachaResult: {
    type: "gacha";
    card: GachaCard;
    userTwitchUsername: string;
  };
  broadcasterTwitchUserId: string;
  streamer: EventSubStreamerInfo;
  userId: string;
}

/**
 * ガチャ結果確定後の通知処理（ブロードキャスト + チャット通知）
 * waitUntil() でレスポンス返却後にバックグラウンド実行される。
 * broadcastとchatは独立しているためPromise.allSettledで並列実行する。
 *
 * Post-redemption notifications (broadcast + chat) run after response via waitUntil().
 * broadcast and chat are independent, so execute in parallel with Promise.allSettled.
 */
async function postRedemptionNotify(data: RedemptionNotifyData): Promise<void> {
  const results = await Promise.allSettled([
    // Realtime通知: waitUntil内でもCPU時間は有限のためリトライを1回に制限
    broadcastGachaResult(data.streamer.id, data.gachaResult, {
      maxRetries: 1,
      retryDelay: 500,
    }),
    sendChatAnnouncement(
      data.broadcasterTwitchUserId,
      data.streamer,
      data.gachaResult.card,
      data.gachaResult.userTwitchUsername,
      data.userId
    ),
  ]);

  // 通知失敗をログ出力 + エラー追跡
  // Note: broadcastGachaResult (i=0) は内部でリトライし失敗時も throw しない設計 (Issue #359-#365)
  // そのため broadcast は 'rejected' にならず、失敗ログは broadcastGachaResult 内で warn として出力される
  // chatAnnouncement (i=1) は引き続きエラー時に throw するため、こちらのみ reportError が機能する
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const label = i === 0 ? 'broadcast' : 'chatAnnouncement';
      logger.warn(`[postRedemptionNotify] ${label} failed`, {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        streamerId: data.streamer.id,
      });
      await reportError(result.reason, {
        context: `eventsub:postRedemptionNotify:${label}`,
        streamerId: data.streamer.id,
        broadcasterTwitchUserId: data.broadcasterTwitchUserId,
      });
    }
  }
}

/**
 * ガチャ実行とデータ準備を行い、通知に必要なデータを返す。
 * 通知処理自体は呼び出し元で waitUntil() により遅延実行される。
 *
 * Execute gacha and prepare data for notifications.
 * Actual notification is deferred by caller via waitUntil().
 *
 * @returns 通知データ（通知不要な場合はnull）
 */
async function handleRedemption(messageId: string, event: {
  broadcaster_user_id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  reward: { id: string; title: string; cost?: number };
}): Promise<RedemptionNotifyData | null> {
  logger.info('[handleRedemption] START', {
    messageId,
    broadcasterUserId: event.broadcaster_user_id,
    userName: event.user_name,
    rewardTitle: event.reward.title,
  });

  const supabaseAdmin = getSupabaseAdmin();

  // 事前の冪等性チェック：既に処理済みのイベントはスキップ
  // RPC内でもON CONFLICTで重複を検知するが、事前チェックがないと
  // ストリーマー設定やカード構成が変わった後のリトライで
  // "Reward ID mismatch" や "No cards available" として誤報告されるため、
  // この事前SELECTは必要（レビュー指摘 P2）
  const { data: existingHistory } = await supabaseAdmin
    .from('gacha_history')
    .select('id')
    .eq('event_id', messageId)
    .maybeSingle();

  if (existingHistory) {
    logger.info('[handleRedemption] Skipped - already processed', { messageId });
    return null;
  }

  try {
    const gachaService = new GachaService();
    const result = await gachaService.executeGachaForEventSub(event, messageId);

    if (!result.success) {
      // EventSub重複通知は正常系（リトライによる再送）なのでエラー報告しない
      // Duplicate event is expected (EventSub retry) - don't report as error
      if (result.error === 'Duplicate event') {
        logger.info('[handleRedemption] Skipped - duplicate event (RPC)', { messageId });
        return null;
      }
      // カード未設定はユーザー設定の問題でありバグではない (Issue #277)
      // "No cards available" is a streamer setup issue, not a system bug
      if (result.error === 'No cards available for this streamer') {
        logger.warn('[handleRedemption] No cards available - streamer setup issue', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
        });
        return null;
      }
      logger.warn('[handleRedemption] Gacha execution failed', { messageId });
      await reportError(new Error(`Gacha execution failed: ${result.error}`), {
        context: 'eventsub:handleRedemption',
        messageId,
        broadcasterUserId: event.broadcaster_user_id,
        gachaError: result.error,
      });
      return null;
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
      return null;
    }

    const gachaResult = {
      type: "gacha" as const,
      card: result.data.card,
      userTwitchUsername: result.data.userTwitchUsername,
    };

    logger.info('[handleRedemption] END', { messageId });

    return {
      gachaResult,
      broadcasterTwitchUserId: event.broadcaster_user_id,
      streamer,
      userId: event.user_id,
    };
  } catch (error) {
    // awaitしないとCloudflare Workersがレスポンス返却後にPromiseを打ち切り、
    // Supabaseへのエラー記録が失われる
    await handleApiError(error, `EventSub redemption (messageId=${messageId})`);
    return null;
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
 */
async function sendChatAnnouncement(
  broadcasterTwitchUserId: string,
  streamer: {
    id: string;
    chat_announcement_enabled: boolean;
    chat_announcement_template: string | null;
  },
  card: GachaCard,
  userName: string,
  userId: string
): Promise<void> {
  // 関数呼び出しを記録（デバッグ用：この関数が呼ばれたことを確認するため）
  // Log function entry to confirm this function is being called
  logger.info('sendChatAnnouncement called', {
    broadcasterTwitchUserId,
    streamerId: streamer.id,
    chatAnnouncementEnabled: streamer.chat_announcement_enabled,
    cardName: card.name,
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
    return;
  }

  // user:write:chatスコープが付与されているかチェック
  // Check if user:write:chat scope is granted
  const hasChatScope = await hasScope(broadcasterTwitchUserId, ADDITIONAL_SCOPES.CHAT_WRITE);
  if (!hasChatScope) {
    logger.info('Chat announcement skipped - missing scope', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
    });
    return;
  }

  // レアリティの日本語/英語変換マップ
  // Rarity translation map
  const rarityMap: Record<string, string> = {
    common: 'コモン',
    rare: 'レア',
    epic: 'エピック',
    legendary: 'レジェンダリー',
  };

  // テンプレートに {num} プレースホルダーが含まれる場合のみカード所持枚数を取得
  // waitUntil内のwall time短縮のため、不要なDBクエリ（users + user_cards）をスキップ
  // Skip card count queries when template doesn't use {num} to reduce wall time in waitUntil
  const effectiveTemplate = streamer.chat_announcement_template || DEFAULT_CHAT_TEMPLATE;
  let cardCount: number | undefined;
  if (effectiveTemplate.includes('{num}')) {
    const supabaseAdminNoCache = getSupabaseAdminNoCache();
    try {
      const { data: user } = await supabaseAdminNoCache
        .from('users')
        .select('id')
        .eq('twitch_user_id', userId)
        .maybeSingle();

      if (user) {
        const { count } = await supabaseAdminNoCache
          .from('user_cards')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .eq('card_id', card.id);

        cardCount = count ?? undefined;
      }
    } catch {
      // カウント取得失敗は無視
    }
  }

  // コレクションページURLを構築
  // Build collection page URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://twica.live';
  const collectionUrl = `${baseUrl}/collection/${streamer.id}`;

  // メッセージのプレースホルダーを構築
  // Build message placeholders
  const placeholders: ChatMessagePlaceholders = {
    user: userName,
    card: card.name,
    rarity: rarityMap[card.rarity] || card.rarity,
    detail: card.description || undefined,
    num: cardCount,
    url: collectionUrl,
  };

  // チャットサービスでメッセージを構築・送信
  // Build and send message using chat service
  const chatService = new TwitchChatService();
  const message = chatService.buildMessage(streamer.chat_announcement_template, placeholders);

  const success = await chatService.sendChatMessage(broadcasterTwitchUserId, message);

  if (success) {
    logger.info('Chat announcement sent', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
      cardName: card.name,
    });
  } else {
    // sendChatMessage が false を返した場合のログ（API呼び出し失敗）
    // Log when sendChatMessage returns false (API call failure)
    logger.warn('Chat announcement failed - sendChatMessage returned false', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
      cardName: card.name,
    });
  }
}
