import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { put } from '@vercel/blob';
import { getSession } from '@/lib/session';
import { logger } from '@/lib/logger';
import { validateUpload, getUploadErrorMessage } from '@/lib/upload-validation';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
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
