import type { Rarity } from "@/types/database";
import { RARITY_ORDER } from "@/lib/constants";

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
 * PR #451 レビュー指摘(F4): ALLOWED_SOUND_HOSTS はどの環境設定にも
 * 設定されていなかったため、「許可ホストで絞り込む」という説明とは裏腹に
 * 実質的にはHTTPSであれば何でも通ってしまう no-op な保護だった。
 *
 * 新たな運用上の設定を1つも増やさずに自己設定的な allowlist にするため、
 * アプリ自身がアップロード済み効果音／画像の公開URLとして実際に使っている
 * R2_SOUND_PUBLIC_URL / R2_PUBLIC_URL（いずれも src/lib/r2-client.ts が使う
 * サーバー専用の環境変数。NEXT_PUBLIC_ プレフィックスが無いためクライアント
 * バンドルには埋め込まれない = ブラウザ側で呼ばれても値は取れず安全側に倒れる）
 * のホスト名を許可リストとして導出する。正規に保存された効果音は必ずこの
 * いずれかのホストに置かれているため、既存の保存済みルールが誤って弾かれる
 * ことはない。
 */
function getDefaultAllowedSoundHosts(): string[] {
  const hosts = new Set<string>();
  for (const publicUrlEnv of [process.env.R2_SOUND_PUBLIC_URL, process.env.R2_PUBLIC_URL]) {
    if (!publicUrlEnv) continue;
    try {
      hosts.add(new URL(publicUrlEnv).hostname.toLowerCase());
    } catch {
      // 設定ミスで不正なURLが入っていても、機能全体を壊さないよう無視する
    }
  }
  return Array.from(hosts);
}

/**
 * 効果音 URL が許可されたものかを判定する。
 * - HTTPS 必須（混在コンテンツ・盗聴防止）
 * - 許可リストは以下の和集合:
 *   1. R2_SOUND_PUBLIC_URL / R2_PUBLIC_URL から導出したホスト（アプリが
 *      実際にアップロード先として使っているホスト。上記 getDefaultAllowedSoundHosts 参照）
 *   2. process.env.ALLOWED_SOUND_HOSTS（カンマ区切りホスト名、任意の追加許可）
 *   または同一オリジンのみ許可
 * - 上記いずれも未設定の場合（ローカル開発でR2環境変数が無い等）は
 *   後方互換のため HTTPS チェックのみで素通しする
 */
export function isAllowedSoundUrl(rawUrl: string): boolean {
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

  const explicitAllowList = (process.env.ALLOWED_SOUND_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  const allowList = Array.from(new Set([...getDefaultAllowedSoundHosts(), ...explicitAllowList]));

  // 後方互換: 導出・明示のどちらの allowlist も空(ローカル開発でR2/明示設定が
  // 無い場合)なら HTTPS のみ満たせば許可する
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

// pickGachaSoundRule と同じ優先順位(reward > rarity > all)。
// 「どのカードを音の代表にするか」の比較にも同じ優先度を使い、一致させる。
const SOUND_RULE_SPECIFICITY: Record<GachaSoundTargetType, number> = {
  reward: 3,
  rarity: 2,
  all: 1,
};

/**
 * N連ガチャの複数カードの中から、効果音を鳴らす1枚を選ぶ（PR #451 レビュー
 * 指摘 F2）。
 *
 * 従来は常に「1枚目のカード」のレアリティだけで効果音ルールを決めていたため、
 * 例えば10連の4枚目にレジェンダリーが出ても、1枚目がコモンならレジェンダリー
 * 音は鳴らなかった。ここではバッチ内の各カードを pickGachaSoundRule で個別に
 * 評価し、一致したルールの具体性(reward > rarity > all)が最も高いカードを選ぶ。
 * 同じ具体性で複数枚が一致する場合(例: レア/レジェンダリー両方のレアリティ
 * ルールが設定されていて両方引いた)は、より希少なレアリティのカードを優先する
 * (RARITY_ORDER: legendary が最も希少 = 配列の先頭)。
 *
 * - soundRules が空(レガシー単一URL設定、ルール非対応)の場合は、従来どおり
 *   1枚目を代表とする(レガシー動作は変えない)。
 * - soundRules が1件以上あるのにどのカードもルールに一致しない場合は -1 を
 *   返す(オーバーレイ側no-matchフォールバック撤廃と一貫して「何も鳴らさない」)。
 *
 * このモジュールに置く理由: 当初 overlay page (page.tsx) の named export と
 * して実装されていたが、Next.js の Page ファイルは規定フィールド以外の
 * export を持てず `next build` の Page 型検証で失敗する(vitest/tsc では
 * 検出されない build 固有の検査)。ロジックの帰属先としても、同じ優先度定義を
 * 持つ pickGachaSoundRule の隣が正しい。
 */
export function pickSoundBearingCardIndex(
  cards: Array<{ rarity: string }>,
  rewardId: string | null | undefined,
  soundRules: GachaSoundRule[],
): number {
  if (soundRules.length === 0) {
    return cards.length > 0 ? 0 : -1;
  }

  let bestIndex = -1;
  let bestSpecificity = 0;
  let bestRarityRank = Number.POSITIVE_INFINITY;

  cards.forEach((card, index) => {
    const rule = pickGachaSoundRule(soundRules, { rarity: card.rarity, rewardId });
    if (!rule) return;

    const specificity = SOUND_RULE_SPECIFICITY[rule.targetType];
    const rawRarityRank = RARITY_ORDER.indexOf(card.rarity);
    const rarityRank = rawRarityRank === -1 ? Number.POSITIVE_INFINITY : rawRarityRank;

    const isMoreSpecific = specificity > bestSpecificity;
    // 「同率なら希少なカードを優先」は rarity ルール同士が並んだ場合に限る
    // (仕様上のtie-break対象)。reward/all は、rewardId が全カード共通の
    // バッチ単位の情報である(=一致すれば全カードが等しく一致する)ため、
    // ここで希少度によるタイブレークを適用すると「常に一番レアなカード」に
    // 音が偏ってしまい非直感的。reward/all の同率タイは、先に一致した
    // (=表示順で先頭の)カードを採用する。
    const isRarityTierTieBreak =
      specificity === bestSpecificity
      && rule.targetType === "rarity"
      && rarityRank < bestRarityRank;

    if (isMoreSpecific || isRarityTierTieBreak) {
      bestIndex = index;
      bestSpecificity = specificity;
      bestRarityRank = rarityRank;
    }
  });

  return bestIndex;
}
