import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { put } from '@vercel/blob';
import { getSession } from '@/lib/session';
import { logger } from '@/lib/logger';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

const TYPE_TO_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
};

function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf('.');
  return lastDotIndex > -1 ? fileName.slice(lastDotIndex + 1).toLowerCase() : '';
}

function validateFileType(mimeType: string, ext: string): boolean {
  const allowedExts = TYPE_TO_EXTENSIONS[mimeType];
  if (!allowedExts) return false;
  return allowedExts.includes(ext);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'ファイルサイズは2MB以下にしてください' }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: '画像ファイル（JPEG, PNG, GIF, WebP）のみ対応しています' }, { status: 400 });
    }

    const ext = getFileExtension(file.name);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json({ error: '許可されていないファイル形式です' }, { status: 400 });
    }

    if (!validateFileType(file.type, ext)) {
      return NextResponse.json({ error: 'ファイル形式が一致しません' }, { status: 400 });
    }

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
