import { put } from '@vercel/blob';
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getSession } from '@/lib/session';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const cookieHeader = request.headers.get('cookie');
    console.log(`[Upload API] Incoming request - Cookie header length: ${cookieHeader?.length || 0}`);

    const session = await getSession();
    if (!session) {
      console.error('[Upload API] User not authenticated. Cookies present:', !!cookieHeader);

      // Debug info for the client
      const debugInfo = {
        cookieHeaderLength: cookieHeader?.length || 0,
        hasSessionCookie: cookieHeader?.includes('twica_session'),
        cookiesSeenByNext: (await cookies()).getAll().map(c => ({ name: c.name, size: c.value.length })),
      };

      return NextResponse.json({
        error: 'Not authenticated',
        debug: debugInfo
      }, { status: 401 });
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
