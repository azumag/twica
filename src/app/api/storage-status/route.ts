import { NextResponse } from 'next/server';
import { getSession, canUseStreamerFeatures } from '@/lib/session';
import { getStorageUsage, formatBytes } from '@/lib/storage-usage';
import { handleApiError } from '@/lib/error-handler';
import { ERROR_MESSAGES, STORAGE_LIMIT_MESSAGES } from '@/lib/constants';
import { sha256Prefix } from '@/lib/crypto-utils';

export async function GET() {
  try {
    const session = await getSession();

    // 認証(401)と認可(403)を分ける (#1569)。
    // 401 は「有効な認証情報が無い」= 再認証で解消する状態を表すため、未認証のときだけ返す。
    // セッションは有効で配信者権限のみ足りない場合は再認証しても解消しないため 403 とする
    // （RFC 9110 の意味論。未知クライアントへ無意味な再認証ループを誘発しない）。
    // 既存の公式 consumer は src/components/CardManager.tsx の fetchStorageStatus() のみで
    // response.ok のみを参照するため、401/403 の別と body の違いは分岐に影響しない。
    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      );
    }

    // storage 機能の書き込み側 (/api/upload, /api/upload/sound) と同じ境界に揃える。
    // storage-status はその読み取り側ゲートなので、セッション無し=401 / 権限なし=403 で揃う。
    if (!canUseStreamerFeatures(session)) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      );
    }

    // Generate user prefix for tracking their uploads
    // ユーザーのアップロードを追跡するためのプレフィックスを生成
    // Web Crypto APIを使用（Cloudflare Workers互換）
    const userPrefix = await sha256Prefix(session.twitchUserId);

    const usage = await getStorageUsage(userPrefix, session.twitchUserId);

    return NextResponse.json({
      userUsage: usage.userUsage,
      globalUsage: usage.globalUsage,
      userUsageFormatted: formatBytes(usage.userUsage),
      globalUsageFormatted: formatBytes(usage.globalUsage),
      userLimitFormatted: formatBytes(usage.userLimitBytes),
      globalLimitFormatted: formatBytes(usage.globalLimitBytes),
      userLimitReached: usage.userLimitReached,
      globalLimitReached: usage.globalLimitReached,
      // planOverLimitの場合もアップロードを無効化
      uploadDisabled: usage.userLimitReached || usage.globalLimitReached || usage.planOverLimit,
      planOverLimit: usage.planOverLimit,
      // 後方互換用の message。公式UIは上記フラグを見て t() で文言を解決するため、
      // ここは未知・外部クライアント向けフォールバックとして維持する（#835, #1345）。
      message: usage.planOverLimit
        ? ERROR_MESSAGES.PLAN_OVER_LIMIT
        : usage.globalLimitReached
          ? STORAGE_LIMIT_MESSAGES.GLOBAL_LIMIT_REACHED
          : usage.userLimitReached
            ? STORAGE_LIMIT_MESSAGES.USER_LIMIT_REACHED
            : null,
    });
  } catch (error) {
    return handleApiError(error, 'Storage Status API');
  }
}
