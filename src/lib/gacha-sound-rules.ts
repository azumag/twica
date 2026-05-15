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

// ルール件数の上限。攻撃的・誤った設定でメモリ／プリロードが膨らむのを防ぐため
// 配信オーバーレイ側のプリロード負荷を考慮した安全上限
export const MAX_GACHA_SOUND_RULES = 50;

/**
 * ルールIDを生成する。crypto.randomUUID が使えればそれを、
 * 無ければ衝突しにくいフォールバックを使う。
 * UI 側でも同一ロジックを使うため export している（重複定義を避ける）。
 */
export const createRuleId = (): string => (
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sound-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

/**
 * 効果音 URL が許可されたものかを判定する。
 * - HTTPS 必須（混在コンテンツ・盗聴防止）
 * - process.env.ALLOWED_SOUND_HOSTS（カンマ区切りホスト名）に含まれるか、
 *   または同一オリジンのみ許可
 * - ALLOWED_SOUND_HOSTS が未設定の場合は後方互換のため素通し
 *   （HTTPS チェックのみ適用）
 */
function isAllowedSoundUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    // ブラウザ環境では相対 URL もあり得るため location.origin を base にする
    const base = typeof location !== "undefined" ? location.origin : undefined;
    parsed = new URL(rawUrl, base);
  } catch {
    return false;
  }

  // HTTPS 必須
  if (parsed.protocol !== "https:") return false;

  const allowList = (process.env.ALLOWED_SOUND_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  // 後方互換: allowlist 未設定なら HTTPS のみ満たせば許可
  if (allowList.length === 0) return true;

  const hostname = parsed.hostname.toLowerCase();
  if (allowList.includes(hostname)) return true;

  // 同一オリジンは常に許可
  if (typeof location !== "undefined" && parsed.origin === location.origin) {
    return true;
  }

  return false;
}

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

  // URL allowlist: HTTPS 必須 + 許可ホスト／同一オリジン制限
  // 任意の外部 URL を配信オーバーレイで再生させない（SSRF/不正音声対策）
  if (!isAllowedSoundUrl(url)) return null;

  const targetType = VALID_TARGET_TYPES.has(raw.targetType as GachaSoundTargetType)
    ? raw.targetType as GachaSoundTargetType
    : "all";
  const rarity = VALID_RARITIES.has(raw.rarity as string) ? raw.rarity as Rarity : null;
  const rewardId = sanitizeText(raw.rewardId, 128);

  // reward 対象なのに rewardId が空のルールは決して発火しない「デッドルール」
  // ストレージ／プリロード／UI を無駄に消費するため正規化時点で除外する
  if (targetType === "reward" && !rewardId) return null;

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
  const normalized = value
    .map(normalizeRule)
    .filter((rule): rule is GachaSoundRule => Boolean(rule));
  // 件数上限を超える分は切り捨てる（メモリ・プリロード負荷の防御）
  return normalized.length > MAX_GACHA_SOUND_RULES
    ? normalized.slice(0, MAX_GACHA_SOUND_RULES)
    : normalized;
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
