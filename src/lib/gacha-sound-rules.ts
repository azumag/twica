import type { Rarity } from "@/types/database";

export type GachaSoundTargetType = "all" | "rarity" | "reward";

export interface GachaSoundRule {
  id: string;
  url: string;
  enabled: boolean;
  label: string;
  targetType: GachaSoundTargetType;
  rarity: Rarity | null;
  rewardId: string | null;
  rewardName: string | null;
}

interface PickSoundContext {
  rarity?: string | null;
  rewardId?: string | null;
}

const VALID_RARITIES = new Set(["common", "rare", "epic", "legendary"]);
const VALID_TARGET_TYPES = new Set<GachaSoundTargetType>(["all", "rarity", "reward"]);

const createRuleId = () => (
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sound-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeRule(value: unknown): GachaSoundRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const url = sanitizeText(raw.url, 2048);
  if (!url) return null;

  const targetType = VALID_TARGET_TYPES.has(raw.targetType as GachaSoundTargetType)
    ? raw.targetType as GachaSoundTargetType
    : "all";
  const rarity = VALID_RARITIES.has(raw.rarity as string) ? raw.rarity as Rarity : null;
  const rewardId = sanitizeText(raw.rewardId, 128);

  return {
    id: sanitizeText(raw.id, 80) ?? createRuleId(),
    url,
    enabled: raw.enabled !== false,
    label: sanitizeText(raw.label, 80) ?? "Sound",
    targetType,
    rarity: targetType === "rarity" ? rarity : null,
    rewardId: targetType === "reward" ? rewardId : null,
    rewardName: targetType === "reward" ? sanitizeText(raw.rewardName, 120) : null,
  };
}

export function normalizeGachaSoundRules(value: unknown): GachaSoundRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeRule)
    .filter((rule): rule is GachaSoundRule => Boolean(rule));
}

export function pickGachaSoundRule(
  rules: GachaSoundRule[],
  context: PickSoundContext,
): GachaSoundRule | null {
  const enabled = rules.filter((rule) => rule.enabled);
  const rewardId = context.rewardId?.trim();
  const rarity = context.rarity?.trim();

  if (rewardId) {
    const rewardRule = enabled.find((rule) => rule.targetType === "reward" && rule.rewardId === rewardId);
    if (rewardRule) return rewardRule;
  }

  if (rarity) {
    const rarityRule = enabled.find((rule) => rule.targetType === "rarity" && rule.rarity === rarity);
    if (rarityRule) return rarityRule;
  }

  return enabled.find((rule) => rule.targetType === "all") ?? null;
}

export function legacySoundToRules(soundUrl: string | null, soundEnabled: boolean): GachaSoundRule[] {
  if (!soundUrl) return [];
  return [{
    id: "legacy-default",
    url: soundUrl,
    enabled: soundEnabled,
    label: "Default sound",
    targetType: "all",
    rarity: null,
    rewardId: null,
    rewardName: null,
  }];
}
