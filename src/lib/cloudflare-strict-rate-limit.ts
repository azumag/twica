/** Optional binding contract. No Cloudflare resource is provisioned by this code. */
export interface StrictRateLimitNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/**
 * Resolve the strict-only Durable Object namespace. Missing binding means the
 * integration is intentionally disabled and callers retain the existing soft
 * limiter. If a production Worker context itself cannot be resolved, callers
 * fail closed because they cannot distinguish a missing binding from a broken
 * deployment context.
 */
export async function getStrictRateLimitNamespace(): Promise<StrictRateLimitNamespaceLike | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    const binding = (context.env as unknown as Record<string, unknown>).STRICT_RATE_LIMITER;
    return binding ? binding as StrictRateLimitNamespaceLike : null;
  } catch (error) {
    if (process.env.NODE_ENV === "production") throw error;
    return null;
  }
}
