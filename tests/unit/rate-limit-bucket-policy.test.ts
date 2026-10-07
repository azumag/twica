import { describe, expect, it } from "vitest";
import { rateLimits } from "@/lib/rate-limit";

/**
 * Rate limit バケットの backend 分類契約 (#728)。
 * PR #1262 の test-only 固定にならい、設計判断 (docs/rate-limit-backend-policy.md)
 * をコードで固定する。backend 自体の変更は含まない。
 *
 * - strict (Durable Object, fail-closed) は総当り防止の2バケットのみ。
 *   勝手に外れると防御の穴、勝手に増えると binding 障害時の 503 範囲が広がる。
 * - soft (KV/memory, fail-open) が既定。それ以外はすべて soft でなければならない。
 */
const STRICT_BUCKETS = ["authLogin", "activateCode"] as const;

describe("rate limit bucket backend policy (#728)", () => {
  it("marks exactly the brute-force buckets as strict", () => {
    const strictNames = Object.entries(rateLimits)
      .filter(([, limiter]) => limiter.strict === true)
      .map(([name]) => name)
      .sort();
    expect(strictNames).toEqual([...STRICT_BUCKETS].sort());
  });

  it("keeps the policy doc's bucket names in sync with the code", () => {
    // docs/rate-limit-backend-policy.md の分類表が指すバケット名が
    // 実コードに存在することを保証する (表と実装の乖離検出用)。
    for (const name of [
      "authLogin",
      "activateCode",
      "global",
      "tradeRead",
      "tradeWrite",
      "gacha",
      "cardsGet",
      "eventsub",
    ] as const) {
      expect(rateLimits[name], `missing bucket: ${name}`).toBeDefined();
    }
  });

  it("keeps trade and browsing buckets on the soft fail-open path", () => {
    for (const name of [
      "global",
      "tradeRead",
      "tradeWrite",
      "gacha",
      "cardsGet",
      "cardsPost",
      "eventsub",
    ] as const) {
      expect(rateLimits[name].strict, `${name} must stay soft`).toBe(false);
    }
  });
});
