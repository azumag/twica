import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { handleApiError, handleBlobError } from '@/lib/error-handler';
import { validateUpload, getUploadErrorMessage } from '@/lib/upload-validation';
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit';
import { ERROR_MESSAGES, UPLOAD_CONFIG, STORAGE_LIMIT_MESSAGES } from '@/lib/constants';
import { getFileTypeFromBuffer, getFileExtension, isValidExtension } from '@/lib/file-utils';
import { logger } from '@/lib/logger';
import { validateCSRFToken } from '@/lib/csrf';
import { uploadToR2WithRetry } from '@/lib/r2-client';
import { retryCloudflareR2Upload } from '@/lib/r2-retry-policy';
import { recordBlobFile } from '@/lib/storage-db';
import { getStorageUsage } from '@/lib/storage-usage';
import { sha256Prefix } from '@/lib/crypto-utils';
import { getUserPlan, PLAN_MAX_UPLOAD_SIZE } from '@/lib/plan';
import type { Session } from '@/lib/session';

interface ValidateRequestResult {
  error?: NextResponse;
  session?: Session;
}

async function validateRequest(request: NextRequest): Promise<ValidateRequestResult> {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.upload, identifier, 10, 60 * 1000);

  if (!rateLimitResult.success) {
    return {
      error: NextResponse.json(
        {
          error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
          retryAfter: rateLimitResult.reset,
        },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': String(rateLimitResult.remaining),
            'X-RateLimit-Reset': String(rateLimitResult.reset),
          },
        }
      ),
    };
  }

  if (!session) {
    return {
      error: NextResponse.json({ error: ERROR_MESSAGES.NOT_AUTHENTICATED }, { status: 401 }),
    };
  }

  return { session };
}

async function validateFile(file: File | null, maxFileSize?: number): Promise<NextResponse | null> {
  if (!file) {
    return NextResponse.json({ error: ERROR_MESSAGES.NO_FILE_SELECTED }, { status: 400 });
  }

  if (!file.name || file.name.trim() === '') {
    return NextResponse.json({ error: ERROR_MESSAGES.FILE_NAME_EMPTY }, { status: 400 });
  }

  // プラン別のmaxFileSizeが指定されている場合はそちらを使用
  const validation = validateUpload(file, maxFileSize);
  if (!validation.valid) {
    return NextResponse.json(
      { error: getUploadErrorMessage(validation.error!) },
      { status: 400 }
    );
  }

  const ext = getFileExtension(file.name);
  if (!ext) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.INVALID_FILE_TYPE },
      { status: 400 }
    );
  }

  if (!isValidExtension(ext)) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.INVALID_FILE_TYPE },
      { status: 400 }
    );
  }

  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  const { error: rateLimitError, session } = await validateRequest(request);
  if (rateLimitError) {
    return rateLimitError;
  }

  // Check storage limits before processing file
  // ファイル処理前にストレージ制限をチェック（ボーナス容量も加味）
  // Web Crypto APIを使用してユーザープレフィックスを生成
  const userPrefix = await sha256Prefix(session!.twitchUserId);

  const storageUsage = await getStorageUsage(userPrefix, session!.twitchUserId);

  if (storageUsage.globalLimitReached) {
    return NextResponse.json(
      {
        error: STORAGE_LIMIT_MESSAGES.GLOBAL_LIMIT_REACHED,
        code: 'GLOBAL_LIMIT_REACHED'
      },
      { status: 507 } // Insufficient Storage
    );
  }

  if (storageUsage.userLimitReached) {
    return NextResponse.json(
      {
        error: STORAGE_LIMIT_MESSAGES.USER_LIMIT_REACHED,
        code: 'USER_LIMIT_REACHED'
      },
      { status: 507 } // Insufficient Storage
    );
  }

  let buffer: Buffer | null = null
  let fileName: string | null = null

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    // プラン別のアップロードサイズ上限を適用
    const plan = await getUserPlan(session!.twitchUserId);
    const maxFileSize = PLAN_MAX_UPLOAD_SIZE[plan];

    const fileValidationError = await validateFile(file, maxFileSize);
    if (fileValidationError) {
      return fileValidationError;
    }

    const ext = getFileExtension(file!.name);
    buffer = Buffer.from(await file!.arrayBuffer());
    const actualType = getFileTypeFromBuffer(buffer);

    const expectedType = UPLOAD_CONFIG.EXT_TO_MIME_TYPE[ext as keyof typeof UPLOAD_CONFIG.EXT_TO_MIME_TYPE];

    if (actualType !== expectedType) {
      logger.warn(`File content does not match extension. Expected: ${expectedType}, Actual: ${actualType}`);
      return NextResponse.json(
        { error: ERROR_MESSAGES.FILE_CONTENT_MISMATCH },
        { status: 400 }
      );
    }

    // User prefix for tracking uploads per user (must match storage-db.ts)
    // ユーザー別アップロード追跡用プレフィックス（storage-db.tsと一致させる）
    // Web Crypto APIを使用（Cloudflare Workers互換）
    const userPrefixForFile = await sha256Prefix(session!.twitchUserId);
    const uniqueSuffix = await sha256Prefix(`${session!.twitchUserId}-${Date.now()}`);

    // Format: {userPrefix}_{uniqueSuffix}.{ext}
    fileName = `${userPrefixForFile}_${uniqueSuffix}.${ext}`;

    // R2にアップロード（Vercel Blobの代わり）
    const uploadResult = await retryCloudflareR2Upload(
      () => uploadToR2WithRetry(fileName!, buffer!, actualType)
    );

    if ('error' in uploadResult) {
      return handleBlobError(
        new Error(uploadResult.error),
        "Upload API: Failed to upload to R2",
        { userId: session!.twitchUserId, fileName, fileSize: buffer.length }
      )
    }

    // DBにファイル情報を記録（使用量追跡用）
    try {
      await recordBlobFile(uploadResult.url, userPrefixForFile, buffer.length, 'r2');
    } catch (dbError) {
      // DB記録に失敗しても、アップロードは成功しているので警告ログのみ
      // 次回の初期化スクリプト実行時に同期される
      logger.warn('Failed to record blob file in DB:', dbError);
    }

    return NextResponse.json({ url: uploadResult.url });
  } catch (error) {
    // R2またはDB操作でのエラーをハンドリング
    const storageError = error instanceof Error && (
      error.message.includes('quota') ||
      error.message.includes('limit') ||
      error.message.includes('authentication') ||
      error.message.includes('service unavailable') ||
      error.message.includes('AccessDenied') ||
      error.message.includes('NetworkingError')
    )

    if (storageError) {
      return handleBlobError(
        error,
        "Upload API: R2 storage error",
        { userId: session?.twitchUserId, fileName: fileName || 'unknown', fileSize: buffer?.length }
      )
    }

    return handleApiError(error, "Upload API");
  }
}
