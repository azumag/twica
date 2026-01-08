import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';

export async function POST(request: Request): Promise<NextResponse> {
  // Try to get session at the very beginning
  const session = await getSession();
  const cookieHeader = request.headers.get('cookie') || 'none';

  console.log(`[Upload API] Initial check - Session: ${session ? session.twitchUserId : 'null'}, Cookie header: ${cookieHeader.substring(0, 30)}...`);

  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // Use the session we fetched at the start
        if (!session) {
          console.error('[Upload API] User not authenticated in callback');
          throw new Error('Not authenticated');
        }

        console.log(`[Upload API] Generating token for ${pathname} (User: ${session.twitchUserId})`);

        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
          tokenPayload: JSON.stringify({
            userId: session.twitchUserId,
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('[Upload API] Upload completed:', blob.url, tokenPayload);
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    console.error('[Upload API] Error:', error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }
}
