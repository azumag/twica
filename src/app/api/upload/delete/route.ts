import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { handleApiError } from "@/lib/error-handler";
import { ERROR_MESSAGES } from "@/lib/constants";
import { deleteOwnedStorageImage } from "@/lib/storage-cleanup";
import { isStorageUrl } from "@/lib/storage-utils";

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

    // Ownership validation + deletion
    // 所有権検証と削除 (#830)
    // 検証と削除の対象キーがずれないよう、判定は削除処理と同じ場所に閉じている。
    const outcome = await deleteOwnedStorageImage(url, session.twitchUserId, "Blob Delete API");

    if (outcome === "forbidden") {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Blob Delete API");
  }
}
