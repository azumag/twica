import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { cookies } from 'next/headers';
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit';

export async function GET(request: Request) {
    const session = await getSession();

    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
    const rateLimitResult = await checkRateLimit(rateLimits.debugSession, identifier);

    if (!rateLimitResult.success) {
        return NextResponse.json(
            { error: "リクエストが多すぎます。しばらく待ってから再試行してください。" },
            {
                status: 429,
                headers: {
                    "X-RateLimit-Limit": String(rateLimitResult.limit),
                    "X-RateLimit-Remaining": String(rateLimitResult.remaining),
                    "X-RateLimit-Reset": String(rateLimitResult.reset),
                },
            }
        );
    }

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
