import { NextResponse } from 'next/server';
import { getSession, canUseStreamerFeatures } from '@/lib/session';
import { getStorageUsage, formatBytes } from '@/lib/storage-usage';
import { handleApiError } from '@/lib/error-handler';
import { ERROR_MESSAGES, STORAGE_LIMIT_MESSAGES } from '@/lib/constants';
import { sha256Prefix } from '@/lib/crypto-utils';

export async function GET() {
  try {
    const session = await getSession();

    // 未認証（セッションなし）は従来どおり 401。ここは変更しない。
    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      );
    }

    // #1569: 認証済みだが配信者機能を利用できない場合は 403 (Forbidden) を返す。
    //
    // 401 は RFC 9110 で「対象リソースへの有効な認証情報が無い」ことを意味し、
    // クライアントには再認証を促すシグナルとして扱われる。権限不足は再認証では
    // 解消しないため、401 のままだと未知クライアントに無意味な再認証ループを
    // 誘発しうる。認証済みセッションに対する権限拒否は 403 が HTTP 意味論に沿う。
    //
    // repo 内の前例: 同じ storage 機能の書き込み側である /api/upload と
    // /api/upload/sound は「セッション無し = 401 NOT_AUTHENTICATED /
    // 配信者権限なし = 403 FORBIDDEN」で既に分岐している（#832, #788）。
    // storage-status はその読み取り側ゲートなので、storage 機能の境界を
    // 揃える意味でも同じ分岐に合わせる。
    //
    // 併せて body も status に対応する FORBIDDEN へ変更する。既知の consumer は
    // src/components/CardManager.tsx の fetchStorageStatus() のみで response.ok
    // しか見ず（body を読まない）、repo 内・公開 GitHub コード検索のいずれでも
    // この応答 body を参照する外部 consumer は確認できていない（#1569 監査）。
    // 未知クライアント向けの互換性判断は #1569 の記録どおり。
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
