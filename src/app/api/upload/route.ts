import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { put } from '@vercel/blob';
import { getSession } from '@/lib/session';
import { handleApiError } from '@/lib/error-handler';
import { validateUpload, getUploadErrorMessage } from '@/lib/upload-validation';
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit';
import { ERROR_MESSAGES, UPLOAD_CONFIG } from '@/lib/constants';
import { getFileTypeFromBuffer, getFileExtension, isValidExtension } from '@/lib/file-utils';
import { logger } from '@/lib/logger';
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
  const { error: rateLimitError, session } = await validateRequest(request);
  if (rateLimitError) {
    return rateLimitError;
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    const fileValidationError = await validateFile(file);
    if (fileValidationError) {
      return fileValidationError;
    }

    const ext = getFileExtension(file!.name);
    const buffer = Buffer.from(await file!.arrayBuffer());
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

    const fileName = `${safeBasename}.${ext}`;

    const blob = await put(fileName, buffer, {
      access: 'public',
    });

    return NextResponse.json({ url: blob.url });
  } catch (error) {
    return handleApiError(error, "Upload API");
  }
}
