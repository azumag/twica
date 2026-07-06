import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_GACHA_SOUND_RULES,
  legacySoundToRules,
  normalizeGachaSoundRules,
  pickGachaSoundRule,
  resolvePlayableGachaSound,
  type GachaSoundRule,
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
    // R2_SOUND_PUBLIC_URL / R2_PUBLIC_URL (F4) はテスト実行環境では通常未設定だが、
    // 他のテストファイル・ローカルの .env 経由での汚染を防ぐため明示的にクリアする。
    beforeEach(() => {
      delete process.env.ALLOWED_SOUND_HOSTS;
      delete process.env.R2_SOUND_PUBLIC_URL;
      delete process.env.R2_PUBLIC_URL;
    });

    afterEach(() => {
      delete process.env.ALLOWED_SOUND_HOSTS;
      delete process.env.R2_SOUND_PUBLIC_URL;
      delete process.env.R2_PUBLIC_URL;
    });

    it("rejects non-HTTPS URLs", () => {
      const rules = normalizeGachaSoundRules([
        { id: "http", url: "http://example.com/a.mp3", targetType: "all" },
        { id: "https", url: "https://example.com/a.mp3", targetType: "all" },
      ]);
      expect(rules.map((r) => r.id)).toEqual(["https"]);
    });

    it("passes through any HTTPS URL when no allowlist source (ALLOWED_SOUND_HOSTS/R2 envs) is configured (backward compat)", () => {
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

    // F4 (PR #451 レビュー指摘): ALLOWED_SOUND_HOSTS がどの環境にも設定されて
    // いなかったため、実質的にはHTTPSであれば何でも許可される no-op な保護に
    // なっていた。アプリが実際にアップロード先として使う R2_SOUND_PUBLIC_URL /
    // R2_PUBLIC_URL のホストから、新たな運用設定を増やさずに allowlist を導出する。
    it("derives the allowlist from R2_SOUND_PUBLIC_URL / R2_PUBLIC_URL hosts when ALLOWED_SOUND_HOSTS is unset", () => {
      process.env.R2_SOUND_PUBLIC_URL = "https://sounds.cdn.example";
      process.env.R2_PUBLIC_URL = "https://images.cdn.example";

      const rules = normalizeGachaSoundRules([
        { id: "sound-host", url: "https://sounds.cdn.example/a.mp3", targetType: "all" },
        { id: "image-host", url: "https://images.cdn.example/b.mp3", targetType: "all" },
        { id: "blocked", url: "https://evil.example/c.mp3", targetType: "all" },
      ]);
      expect(rules.map((r) => r.id).sort()).toEqual(["image-host", "sound-host"]);
    });

    it("unions R2-derived hosts with an explicit ALLOWED_SOUND_HOSTS", () => {
      process.env.R2_SOUND_PUBLIC_URL = "https://sounds.cdn.example";
      process.env.ALLOWED_SOUND_HOSTS = "extra.allowed.com";

      const rules = normalizeGachaSoundRules([
        { id: "sound-host", url: "https://sounds.cdn.example/a.mp3", targetType: "all" },
        { id: "explicit-host", url: "https://extra.allowed.com/b.mp3", targetType: "all" },
        { id: "blocked", url: "https://evil.example/c.mp3", targetType: "all" },
      ]);
      expect(rules.map((r) => r.id).sort()).toEqual(["explicit-host", "sound-host"]);
    });

    it("keeps validating an already-saved rule on the R2 sound host once the allowlist is derived", () => {
      // 既存の保存済みルールが、導出後のallowlistでも引き続き有効であることを確認する
      // (＝正規のアップロード先を誤って弾かない、というF4修正の安全性要件)。
      process.env.R2_SOUND_PUBLIC_URL = "https://sounds.cdn.example/";
      const rules = normalizeGachaSoundRules([
        { id: "existing", url: "https://sounds.cdn.example/existing.mp3", targetType: "all" },
      ]);
      expect(rules.map((r) => r.id)).toEqual(["existing"]);
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

  describe("resolvePlayableGachaSound (Issue #638)", () => {
    const rule = (overrides: Partial<GachaSoundRule>): GachaSoundRule => ({
      id: "id",
      url: "https://example.com/s.mp3",
      enabled: true,
      label: "L",
      targetType: "all",
      rarity: null,
      rewardId: null,
      rewardName: null,
      ...overrides,
    });

    it("#638の再現ケース: rarity限定の有効ルールのみ設定されている配信は、レガシーミラー(soundEnabled)がfalseでも一致すれば再生できる", () => {
      const rules = [rule({ id: "legendary-rule", targetType: "rarity", rarity: "legendary" })];
      // PR #595 F1により、catch-allルールが無いためサーバー側ミラーは
      // soundEnabled=falseで届く。これに引きずられず一致すれば再生できることを確認する。
      const result = resolvePlayableGachaSound(
        { soundUrl: null, soundEnabled: false, soundRules: rules },
        { rarity: "legendary", rewardId: null },
      );
      expect(result).toEqual({ url: "https://example.com/s.mp3", cacheKey: "legendary-rule" });
    });

    it("報酬限定ルールも同様に、ミラーがfalseでもrewardId一致で再生できる", () => {
      const rules = [
        rule({ id: "reward-rule", url: "https://example.com/reward.mp3", targetType: "reward", rewardId: "reward-1" }),
      ];
      const result = resolvePlayableGachaSound(
        { soundUrl: null, soundEnabled: false, soundRules: rules },
        { rarity: "common", rewardId: "reward-1" },
      );
      expect(result).toEqual({ url: "https://example.com/reward.mp3", cacheKey: "reward-rule" });
    });

    it("ルールが非空でもどれにも一致しなければnull(レガシーurlがあってもフォールバックしない、F1bの維持)", () => {
      const rules = [rule({ id: "legendary-rule", targetType: "rarity", rarity: "legendary" })];
      const result = resolvePlayableGachaSound(
        { soundUrl: "https://example.com/legacy.mp3", soundEnabled: true, soundRules: rules },
        { rarity: "common", rewardId: null },
      );
      expect(result).toBeNull();
    });

    it("ルールが空 + レガシーurl + soundEnabled: trueなら、レガシーurlを__legacy__キーで返す", () => {
      const result = resolvePlayableGachaSound(
        { soundUrl: "https://example.com/legacy.mp3", soundEnabled: true, soundRules: [] },
        { rarity: "common", rewardId: null },
      );
      expect(result).toEqual({ url: "https://example.com/legacy.mp3", cacheKey: "__legacy__" });
    });

    it("ルールが空 + レガシーurl + soundEnabled: falseならnull", () => {
      const result = resolvePlayableGachaSound(
        { soundUrl: "https://example.com/legacy.mp3", soundEnabled: false, soundRules: [] },
        { rarity: "common", rewardId: null },
      );
      expect(result).toBeNull();
    });

    it("ルールが空 + url: nullならnull", () => {
      const result = resolvePlayableGachaSound(
        { soundUrl: null, soundEnabled: true, soundRules: [] },
        { rarity: "common", rewardId: null },
      );
      expect(result).toBeNull();
    });

    it("無効化(enabled: false)されたルールのみの場合はnull", () => {
      const rules = [rule({ id: "disabled-rule", enabled: false, targetType: "all" })];
      const result = resolvePlayableGachaSound(
        { soundUrl: null, soundEnabled: true, soundRules: rules },
        { rarity: "common", rewardId: null },
      );
      expect(result).toBeNull();
    });
  });
});
