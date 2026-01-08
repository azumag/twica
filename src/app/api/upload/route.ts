import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) {
      console.error('[Upload API] User not authenticated');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    console.log(`[Upload API] Uploading ${file.name} for user ${session.twitchUserId}`);

    const blob = await put(file.name, file, {
      access: 'public',
    });

    console.log(`[Upload API] Upload successful: ${blob.url}`);

    return NextResponse.json(blob);
  } catch (error) {
    console.error('[Upload API] Error:', error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
