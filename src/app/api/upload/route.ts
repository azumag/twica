import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { put } from '@vercel/blob';
import { getSession } from '@/lib/session';
import { logger } from '@/lib/logger';
import { validateUpload, getUploadErrorMessage } from '@/lib/upload-validation';
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.upload, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      {
        error: 'リクエストが多すぎます。しばらく待ってから再試行してください。',
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
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    const validation = validateUpload(file);
    if (!validation.valid) {
      return NextResponse.json(
        { error: getUploadErrorMessage(validation.error!, validation.maxSize) },
        { status: 400 }
      );
    }

    if (!file || !file.name || file.name.trim() === '') {
      return NextResponse.json({ error: 'ファイル名が空です' }, { status: 400 });
    }

    const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
    const fileName = `${session.twitchUserId}-${randomUUID()}.${ext}`;

    const blob = await put(fileName, file, {
      access: 'public',
    });

    return NextResponse.json({ url: blob.url });
  } catch (error) {
    logger.error('[Upload API] Error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
