import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { put } from '@vercel/blob';
import { getSession } from '@/lib/session';
import { handleApiError } from '@/lib/error-handler';
import { validateUpload, getUploadErrorMessage } from '@/lib/upload-validation';
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit';
import { ERROR_MESSAGES } from '@/lib/constants';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.upload, identifier, 10, 60 * 1000);

  if (!rateLimitResult.success) {
    return NextResponse.json(
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
    );
  }

  try {
    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.NOT_AUTHENTICATED }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    const validation = validateUpload(file);
    if (!validation.valid) {
      return NextResponse.json(
        { error: getUploadErrorMessage(validation.error!) },
        { status: 400 }
      );
    }

    if (!file || !file.name || file.name.trim() === '') {
      return NextResponse.json({ error: ERROR_MESSAGES.FILE_NAME_EMPTY }, { status: 400 });
    }

    const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
    const fileName = `${session.twitchUserId}-${randomUUID()}.${ext}`;

    const blob = await put(fileName, file, {
      access: 'public',
    });

    return NextResponse.json({ url: blob.url });
  } catch (error) {
    return handleApiError(error, "Upload API");
  }
}
