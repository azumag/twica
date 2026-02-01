import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { handleApiError } from "@/lib/error-handler";
import { ERROR_MESSAGES } from "@/lib/constants";
import { deleteFromR2 } from "@/lib/r2-client";
import { removeBlobFile } from "@/lib/storage-db";
import { isR2Url, isVercelBlobUrl, isStorageUrl, getR2KeyFromUrl } from "@/lib/storage-utils";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    // Content-Type validation
    // Content-Type検証
    const contentTypeValidation = validateContentType(request, "application/json");
    if (contentTypeValidation) {
      return contentTypeValidation;
    }

    // CSRF validation
    // CSRF検証
    const csrfValidation = await validateCSRFToken(request);
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      );
    }

    // Session validation
    // セッション検証
    const session = await getSession();
    if (!session || !canUseStreamerFeatures(session)) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      );
    }

    // Rate limiting
    // レート制限
    const identifier = await getRateLimitIdentifier(request, session.twitchUserId);
    const rateLimitResult = await checkRateLimit(rateLimits.upload, identifier);

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

    const body = await request.json();
    const { url } = body;

    if (!url || typeof url !== "string") {
      return NextResponse.json(
        { error: "URL is required" },
        { status: 400 }
      );
    }

    // Validate that the URL is a storage URL (R2 or Vercel Blob)
    // URLがストレージURL（R2またはVercel Blob）であることを検証
    if (!isStorageUrl(url)) {
      return NextResponse.json(
        { error: "Invalid storage URL" },
        { status: 400 }
      );
    }

    // DBからファイル情報を取得し、削除
    // これにより使用量も自動的に減算される
    try {
      await removeBlobFile(url);
    } catch (dbError) {
      // DB操作に失敗しても、ストレージからの削除は続行
      // 使用量が不整合になる可能性があるが、初期化スクリプトで修正可能
      logger.warn('Failed to remove blob file from DB:', dbError);
    }

    // ストレージから削除（R2のみ）
    // Note: Vercel Blob deletion removed - only R2 is supported now
    // 注意: Vercel Blob削除を削除 - R2のみサポート
    if (isR2Url(url)) {
      // R2から削除
      const key = getR2KeyFromUrl(url);
      if (key) {
        await deleteFromR2(key);
        logger.info(`Deleted R2 file: ${key}`);
      } else {
        logger.warn(`Could not extract key from R2 URL: ${url}`);
      }
    } else if (isVercelBlobUrl(url)) {
      // Vercel Blob URLs are no longer actively deleted
      // Migration to R2 should have moved these files
      // Vercel Blob URLは削除しない（R2移行済みのはず）
      logger.warn(`Vercel Blob URL found but deletion skipped: ${url}`);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Blob Delete API");
  }
}
