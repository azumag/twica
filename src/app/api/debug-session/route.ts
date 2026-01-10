import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { cookies } from 'next/headers';

export async function GET() {
    const session = await getSession();
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll().map(c => ({ name: c.name, value: c.name === 'twica_session' ? '[REDACTED]' : c.value }));

    return NextResponse.json({
        authenticated: !!session,
        session: session ? {
            twitchUserId: session.twitchUserId,
            twitchUsername: session.twitchUsername,
        } : null,
        cookies: allCookies,
        timestamp: new Date().toISOString(),
    });
}
