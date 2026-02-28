import { NextResponse } from 'next/server';
import { getSession, canUseStreamerFeatures } from '@/lib/session';
import { getStorageUsage, formatBytes } from '@/lib/storage-usage';
import { handleApiError } from '@/lib/error-handler';
import { ERROR_MESSAGES, STORAGE_LIMIT_MESSAGES } from '@/lib/constants';
import { sha256Prefix } from '@/lib/crypto-utils';

export async function GET() {
  try {
    const session = await getSession();

    if (!session || !canUseStreamerFeatures(session)) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
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
