import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { logger } from "./logger";
import * as Sentry from "@sentry/nextjs";

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

// Circuit breaker state management
interface CircuitBreakerState {
  isOpen: boolean;
  lastFailureTime: number;
  failureCount: number;
  nextAttemptTime: number;
}

const CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 5, // Open after 5 consecutive failures
  resetTimeout: 60000, // Retry after 60 seconds
  halfOpenAttempts: 1, // Try once in half-open state
} as const;

const circuitBreaker: CircuitBreakerState = {
  isOpen: false,
  lastFailureTime: 0,
  failureCount: 0,
  nextAttemptTime: 0,
};

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

// Helper function to check if we're in development mode
function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

// Circuit breaker management functions
function shouldBlockDueToCircuitBreaker(): boolean {
  return circuitBreaker.isOpen;
}

function updateCircuitBreakerOnResult(success: boolean): void {
  const now = Date.now();
  
  if (success) {
    updateCircuitBreakerState({
      failureCount: 0,
      isOpen: false,
    });
    return;
  }
  
  const newFailureCount = circuitBreaker.failureCount + 1;
  
  if (newFailureCount >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
    updateCircuitBreakerState({
      failureCount: newFailureCount,
      lastFailureTime: now,
      isOpen: true,
      nextAttemptTime: now + CIRCUIT_BREAKER_CONFIG.resetTimeout,
    });
    logger.error('Circuit breaker opened due to repeated failures');
    return;
  }
  
  updateCircuitBreakerState({
    failureCount: newFailureCount,
    lastFailureTime: now,
  });
}

function canAttempt(): boolean {
  const now = Date.now();
  
  if (!circuitBreaker.isOpen) {
    return true;
  }
  
  if (now >= circuitBreaker.nextAttemptTime) {
    updateCircuitBreakerState({
      isOpen: false,
      failureCount: 0,
    });
    logger.info('Circuit breaker reset, allowing requests');
    return true;
  }
  
  return false;
}





// In-memory rate limiting fallback
function checkInMemoryRateLimit(
  limit: number,
  windowMs: number,
  identifier: string
): RateLimitResult {
  const now = Date.now();
  const existing = memoryStore.get(identifier);
  const resetTime = now + windowMs;
  
  if (!existing || now > existing.resetTime) {
    memoryStore.set(identifier, { count: 1, resetTime });
    return {
      success: true,
      limit,
      remaining: limit - 1,
      reset: resetTime,
    };
  }
  
  if (existing.count >= limit) {
    return {
      success: false,
      limit,
      remaining: 0,
      reset: existing.resetTime,
    };
  }
  
  existing.count++;
  return {
    success: true,
    limit,
    remaining: limit - existing.count,
    reset: existing.resetTime,
  };
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
      return checkInMemoryRateLimit(limit, windowMs, identifier);
    },
  };
}

// Legacy rate limits for backward compatibility
export const rateLimits = {
  upload: createRatelimit(10, 60 * 1000),
  cardsPost: createRatelimit(20, 60 * 1000),
  cardsGet: createRatelimit(100, 60 * 1000),
  cardsId: createRatelimit(100, 60 * 1000),
  streamerSettings: createRatelimit(10, 60 * 1000),
  gacha: createRatelimit(30, 60 * 1000),
  battleStart: createRatelimit(20, 60 * 1000),
  battleGet: createRatelimit(100, 60 * 1000),
  battleStats: createRatelimit(50, 60 * 1000),
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







// Update circuit breaker state (needs mutable access)
function updateCircuitBreakerState(newState: Partial<CircuitBreakerState>) {
  Object.assign(circuitBreaker, newState);
}

// Enhanced rate limit check with fail-closed behavior
export async function checkRateLimit(
  ratelimit: RateLimiter | Ratelimit,
  identifier: string,
  limit?: number,
  windowMs?: number
): Promise<{ success: boolean; limit?: number; remaining?: number; reset?: number }> {
  // Check if circuit breaker allows requests
  if (!canAttempt()) {
    logger.warn('Circuit breaker is open, blocking all requests');
    return {
      success: false,
      limit: limit || 0,
      remaining: 0,
      reset: circuitBreaker.nextAttemptTime,
    };
  }
  
  // Try the rate limit with error handling
  try {
    const result = await ratelimit.limit(identifier);
    updateCircuitBreakerOnResult(true);
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (error) {
    logger.error("Rate limit check failed:", error);
    updateCircuitBreakerOnResult(false);
    
    Sentry.captureException(error, {
      level: 'error',
      tags: {
        component: 'rate-limit',
        operation: 'fallback',
      },
      extra: {
        identifier,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    
    // Check if circuit breaker is now open after this failure
    if (shouldBlockDueToCircuitBreaker()) {
      return {
        success: false,
        limit: limit || 0,
        remaining: 0,
        reset: circuitBreaker.nextAttemptTime,
      };
    }
    
    // Development environment fallback
    if (isDevelopment() && limit && windowMs) {
      return checkInMemoryRateLimit(limit, windowMs, identifier);
    }
    
    // Production environment - fail closed
    return { 
      success: false,
      limit: limit || 0,
      remaining: 0,
      reset: Date.now() + (windowMs || 60000),
    };
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
