import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_GACHA_SOUND_RULES,
  legacySoundToRules,
  normalizeGachaSoundRules,
  pickGachaSoundRule,
} from "@/lib/gacha-sound-rules";

describe("gacha sound rules", () => {
  it("normalizes only playable rules", () => {
    const rules = normalizeGachaSoundRules([
      { id: "a", url: "https://example.com/a.mp3", label: "A", targetType: "rarity", rarity: "legendary" },
      { id: "b", url: "", targetType: "all" },
      { id: "c", url: "https://example.com/c.mp3", targetType: "reward", rewardId: "reward-1", rewardName: "VIP" },
      null,
    ]);

    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ id: "a", targetType: "rarity", rarity: "legendary" });
    expect(rules[1]).toMatchObject({ id: "c", targetType: "reward", rewardId: "reward-1" });
  });

  it("prefers reward rules over rarity rules and default rules", () => {
    const rules = normalizeGachaSoundRules([
      { id: "default", url: "https://example.com/default.mp3", targetType: "all" },
      { id: "rare", url: "https://example.com/rare.mp3", targetType: "rarity", rarity: "rare" },
      { id: "reward", url: "https://example.com/reward.mp3", targetType: "reward", rewardId: "reward-1" },
    ]);

    expect(pickGachaSoundRule(rules, { rarity: "rare", rewardId: "reward-1" })?.id).toBe("reward");
    expect(pickGachaSoundRule(rules, { rarity: "rare", rewardId: "reward-2" })?.id).toBe("rare");
    expect(pickGachaSoundRule(rules, { rarity: "common", rewardId: null })?.id).toBe("default");
  });

  it("preserves legacy single sound as an all-draw rule", () => {
    expect(legacySoundToRules("https://example.com/sound.mp3", true)).toEqual([
      expect.objectContaining({
        id: "legacy-default",
        url: "https://example.com/sound.mp3",
        enabled: true,
        targetType: "all",
      }),
    ]);
  });

  it("drops reward rules with empty/missing rewardId (dead rules)", () => {
    const rules = normalizeGachaSoundRules([
      { id: "no-reward", url: "https://example.com/a.mp3", targetType: "reward" },
      { id: "blank-reward", url: "https://example.com/b.mp3", targetType: "reward", rewardId: "   " },
      { id: "ok", url: "https://example.com/c.mp3", targetType: "reward", rewardId: "reward-1" },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: "ok", rewardId: "reward-1" });
  });

  describe("URL allowlist", () => {
    afterEach(() => {
      delete process.env.ALLOWED_SOUND_HOSTS;
    });

    it("rejects non-HTTPS URLs", () => {
      const rules = normalizeGachaSoundRules([
        { id: "http", url: "http://example.com/a.mp3", targetType: "all" },
        { id: "https", url: "https://example.com/a.mp3", targetType: "all" },
      ]);
      expect(rules.map((r) => r.id)).toEqual(["https"]);
    });

    it("passes through any HTTPS URL when ALLOWED_SOUND_HOSTS is unset (backward compat)", () => {
      const rules = normalizeGachaSoundRules([
        { id: "a", url: "https://any-host.example/a.mp3", targetType: "all" },
      ]);
      expect(rules).toHaveLength(1);
    });

    it("restricts to ALLOWED_SOUND_HOSTS when set", () => {
      process.env.ALLOWED_SOUND_HOSTS = "cdn.allowed.com, media.allowed.com";
      const rules = normalizeGachaSoundRules([
        { id: "allowed", url: "https://cdn.allowed.com/a.mp3", targetType: "all" },
        { id: "allowed2", url: "https://media.allowed.com/b.mp3", targetType: "all" },
        { id: "blocked", url: "https://evil.example/c.mp3", targetType: "all" },
      ]);
      expect(rules.map((r) => r.id).sort()).toEqual(["allowed", "allowed2"]);
    });
  });

  it("caps the number of rules at MAX_GACHA_SOUND_RULES", () => {
    const input = Array.from({ length: MAX_GACHA_SOUND_RULES + 25 }, (_, i) => ({
      id: `rule-${i}`,
      url: `https://example.com/${i}.mp3`,
      targetType: "all" as const,
    }));
    const rules = normalizeGachaSoundRules(input);
    expect(rules).toHaveLength(MAX_GACHA_SOUND_RULES);
    expect(rules[0].id).toBe("rule-0");
  });
});
