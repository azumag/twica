import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { logger } from "./logger";

interface RateLimitStore {
  count: number;
  resetTime: number;
}

interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

interface RateLimiter {
  limit: (identifier: string) => Promise<RateLimitResult>;
}

const redis = process.env.UPSTASH_REDIS_REST_URL
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

const memoryStore = new Map<string, RateLimitStore>();

if (!redis) {
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of memoryStore.entries()) {
      if (now > record.resetTime) {
        memoryStore.delete(key);
      }
    }
  }, 60 * 1000);
}

function createRatelimit(limit: number, windowMs: number): RateLimiter {
  if (redis) {
    return new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
      analytics: true,
    });
  }

  return {
    limit: async (identifier: string): Promise<RateLimitResult> => {
      const now = Date.now();
      const existing = memoryStore.get(identifier);
      const resetTime = now + windowMs;

      if (!existing || now > existing.resetTime) {
        memoryStore.set(identifier, { count: 1, resetTime });
        return { success: true, limit, remaining: limit - 1, reset: resetTime };
      }

      const newCount = existing.count + 1;
      memoryStore.set(identifier, { count: newCount, resetTime: existing.resetTime });

      if (newCount > limit) {
        return { success: false, limit, remaining: 0, reset: existing.resetTime };
      }

      return { success: true, limit, remaining: limit - newCount, reset: existing.resetTime };
    },
  };
}

export const rateLimits = {
  upload: createRatelimit(10, 60 * 1000),
  cardsPost: createRatelimit(20, 60 * 1000),
  cardsGet: createRatelimit(100, 60 * 1000),
  cardsId: createRatelimit(100, 60 * 1000),
  streamerSettings: createRatelimit(10, 60 * 1000),
  gacha: createRatelimit(30, 60 * 1000),
  authLogin: createRatelimit(5, 60 * 1000),
  authCallback: createRatelimit(10, 60 * 1000),
  authLogout: createRatelimit(10, 60 * 1000),
  eventsub: createRatelimit(1000, 60 * 1000),
  twitchRewardsGet: createRatelimit(50, 60 * 1000),
  twitchRewardsPost: createRatelimit(20, 60 * 1000),
  eventsubSubscribePost: createRatelimit(10, 60 * 1000),
  eventsubSubscribeGet: createRatelimit(50, 60 * 1000),
  gachaHistoryDelete: createRatelimit(30, 60 * 1000),
  debugSession: createRatelimit(10, 60 * 1000),
} as const;

export async function checkRateLimit(
  ratelimit: RateLimiter | Ratelimit,
  identifier: string
): Promise<{ success: boolean; limit?: number; remaining?: number; reset?: number }> {
  try {
    const result = await ratelimit.limit(identifier);
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (error) {
    logger.error("Rate limit check failed:", error);
    return { success: true };
  }
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return "unknown";
}

export async function getRateLimitIdentifier(
  request: Request,
  twitchUserId?: string
): Promise<string> {
  if (twitchUserId) {
    return `user:${twitchUserId}`;
  }

  const ip = getClientIp(request);
  return `ip:${ip}`;
}
