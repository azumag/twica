import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { cookies } from 'next/headers';
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit';
import { handleApiError } from '@/lib/error-handler';
import { ERROR_MESSAGES, DEBUG_CONFIG } from '@/lib/constants';

export async function GET(request: Request) {
    try {
        // Check if running in production
        if (process.env.NODE_ENV === DEBUG_CONFIG.PRODUCTION_ENV) {
            return NextResponse.json(
                { error: ERROR_MESSAGES.DEBUG_ENDPOINT_NOT_AVAILABLE },
                { status: 404 }
            );
        }

        // Check if request is from localhost
        const url = new URL(request.url);
        const host = url.hostname;

        if (!DEBUG_CONFIG.ALLOWED_HOSTS.some(allowedHost => allowedHost === host)) {
            return NextResponse.json(
                { error: ERROR_MESSAGES.DEBUG_ENDPOINT_NOT_AUTHORIZED },
                { status: 403 }
            );
        }

        const session = await getSession();

        const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
        const rateLimitResult = await checkRateLimit(rateLimits.debugSession, identifier);

        if (!rateLimitResult.success) {
            return NextResponse.json(
                { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
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
        
        // Only return cookie names, never values
        const cookieNames = cookieStore.getAll().map(c => c.name);

        return NextResponse.json({
            authenticated: !!session,
            session: session ? {
                twitchUserId: session.twitchUserId,
                twitchUsername: session.twitchUsername,
            } : null,
            cookies: cookieNames,  // Only names, not values
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV,
        });
    } catch (error) {
        return handleApiError(error, "Debug Session API: GET");
    }
}
