import { describe, expect, it } from "vitest";
import {
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
});
