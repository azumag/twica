import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { getSession } from '@/lib/session';
import { handleApiError, handleBlobError, uploadWithRetry } from '@/lib/error-handler';
import { validateUpload, getUploadErrorMessage } from '@/lib/upload-validation';
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit';
import { ERROR_MESSAGES, UPLOAD_CONFIG, STORAGE_LIMIT_MESSAGES } from '@/lib/constants';
import { getFileTypeFromBuffer, getFileExtension, isValidExtension } from '@/lib/file-utils';
import { logger } from '@/lib/logger';
import { validateCSRFToken } from '@/lib/csrf';
import { getStorageUsage } from '@/lib/storage-usage';
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

async function validateFile(file: File | null): Promise<NextResponse | null> {
  if (!file) {
    return NextResponse.json({ error: ERROR_MESSAGES.NO_FILE_SELECTED }, { status: 400 });
  }

  if (!file.name || file.name.trim() === '') {
    return NextResponse.json({ error: ERROR_MESSAGES.FILE_NAME_EMPTY }, { status: 400 });
  }

  const validation = validateUpload(file);
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
  // ファイル処理前にストレージ制限をチェック
  const userPrefix = createHash('sha256')
    .update(session!.twitchUserId)
    .digest('hex')
    .substring(0, 8);

  const storageUsage = await getStorageUsage(userPrefix);

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

    const fileValidationError = await validateFile(file);
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

    const safeBasename = createHash('sha256')
      .update(`${session!.twitchUserId}-${Date.now()}`)
      .digest('hex')
      .substring(0, 16);

    fileName = `${safeBasename}.${ext}`;

    const uploadResult = await uploadWithRetry(fileName, buffer, { access: 'public' });

    if ('error' in uploadResult) {
      return handleBlobError(
        new Error(uploadResult.error),
        "Upload API: Failed to upload to Vercel Blob",
        { userId: session!.twitchUserId, fileName, fileSize: buffer.length }
      )
    }

    return NextResponse.json({ url: uploadResult.url });
  } catch (error) {
    const blobError = error instanceof Error && (
      error.message.includes('quota') ||
      error.message.includes('limit') ||
      error.message.includes('authentication') ||
      error.message.includes('service unavailable')
    )

    if (blobError) {
      return handleBlobError(
        error,
        "Upload API: Vercel Blob error",
        { userId: session?.twitchUserId, fileName: fileName || 'unknown', fileSize: buffer?.length }
      )
    }

    return handleApiError(error, "Upload API");
  }
}
