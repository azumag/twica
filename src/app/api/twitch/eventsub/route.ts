import { NextRequest, NextResponse } from "next/server";
import { TWITCH_SUBSCRIPTION_TYPE, ERROR_MESSAGES } from "@/lib/constants";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getClientIp } from "@/lib/rate-limit";
import { logger } from "@/lib/logger.server";
import { reportError } from "@/lib/sentry/error-handler";
import { getMaintenanceState } from "@/lib/maintenance/state";
import { parkEventSubNotification } from "@/lib/maintenance/eventsub-park";
// Issue #787 Stage 1: ガチャ交換・レイド処理ロジック本体は
// src/lib/services/eventsub-redemption.ts へ純粋移動した（ロジック変更なし）。
// Issue #787 Stage 3 の /api/admin/eventsub-replay route が同じ handleRedemption /
// handleRaidNotification を再利用できるようにするための抽出。
import { handleRedemption, handleRaidNotification, postRedemptionNotify, runInBackground } from "@/lib/services/eventsub-redemption";

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

    // #694 Stage 4: maintenance mode（'off'以外）中は notification をDBへ書き込まず
    // KVへ退避し、Twitchには通常どおり2xxを返す。
    //
    // - 挿入位置: 署名検証（POSTハンドラ冒頭）より後、かつ実際にDB書き込みを行う
    //   handleRedemption/handleRaidNotificationより前。署名検証前に退避すると
    //   偽payloadがKVに混入するため必ず検証後でなければならない。なお、この
    //   route には「重複チェック」という独立した事前ステップは存在せず
    //   （event_id の重複判定はDB書き込み関数内部のON CONFLICTに一本化されている、
    //   gacha.ts 参照）、DB書き込み関数の直前がこのroute構造上の最も早い安全な
    //   挿入点になる。
    // - Twitchへの5xxはEventSub subscriptionのrevoke判定材料になりうるため、
    //   maintenance中でも「受信失敗」を装う503/500は厳禁という制約が本Stage全体の
    //   前提（guard.tsが一般writeに503を返すのとは非対称にEventSubだけ常に2xx）。
    //   KV退避が失敗した場合も同じ理由で2xxを返す（parkEventSubNotification内の
    //   コメント参照）。
    // - challenge（webhook_callback_verification）とrevocationはこの分岐に入らず
    //   従来どおり処理する。challengeはDB書き込みを一切行わない。revocationは
    //   「予期しない」理由の場合のみreportError経由でerrorsテーブルへ書き込むが、
    //   これは診断目的の運用ログでありガチャ結果等の業務データではないこと、また
    //   インシデント対応中（incident-read-only）こそその可視性が必要であることから、
    //   意図的に退避/抑制の対象外とした（実装報告に判断根拠を記載）。
    // - subscriptionTypeで分岐せずnotification全件を退避する: 現状DB書き込みを
    //   伴うのはCHANNEL_POINTS_REDEMPTION_ADDとCHANNEL_RAIDの2種のみだが、将来
    //   subscriptionTypeが追加された際に「退避対象への追加を個別に忘れる」事故を
    //   構造的に防ぐため、notification全体を退避対象にする（Stage 3の
    //   allowlist default-denyと同じfail-safeの考え方）。
    const maintenanceState = getMaintenanceState();
    if (maintenanceState.mode !== 'off') {
      await parkEventSubNotification({
        messageId,
        payload: data,
        subscriptionType,
        maintenanceState,
      });
      return NextResponse.json({ received: true });
    }

    if (subscriptionType === TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD) {
      // ガチャ実行のみawaitし、通知処理はwaitUntil()で遅延実行してCPU時間を削減
      // Only await gacha execution; defer notifications via waitUntil() to reduce CPU time
      const result = await handleRedemption(messageId, event);
      if (result.notify) {
        await runInBackground('gacha redemption', postRedemptionNotify(result.notify));
      }
    } else if (subscriptionType === TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID) {
      const result = await handleRaidNotification(messageId, event);
      if (result.notify) {
        await runInBackground('raid gift', postRedemptionNotify(result.notify));
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
