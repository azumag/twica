// Issue #1782（要望 #1728）: 被り（重複）カードの「表示段階」の純粋ロジック。
//
// 配信者がレアリティごとに「所有枚数がこの枚数を超えたら表示段階を1つ上げる」
// というしきい値を設定し、視聴者側のコレクション / カード詳細で段階に応じた
// 枠・バッジを出す。経済（石への交換レートや確定ガチャ）は #534 / #519 の
// 既存基盤が担当するため、本モジュールは「表示の切替」だけを扱う。
//
// collection-album.ts / collection-packs.ts と同じく DB・React 非依存とし、
// Server Component（視聴者表示）/ API route（保存側の検証）/ Client Component
// （設定UI）のすべてから同一の規則で解決できるようにする。表示側と保存側で
// 検証規則がずれると「保存できたのに反映されない」が起きるため、規則は
// この1ファイルにのみ置く。
//
// Issue #1782 (request #1728): pure rules for the duplicate-card display
// tiers. A streamer configures, per rarity, the owned-copy counts at which a
// card's display tier steps up; the viewer's collection and card detail then
// render the matching frame/badge. The card economy itself (stone exchange
// rates, guaranteed-rarity gacha) stays with #534 / #519 — this module only
// decides which tier to display.

// レアリティ名の検証規則は rarity_weights (#578) と完全に共通化する。
// 独自の正規表現を置くと、保存側（ここ）と rarity_weights 側で「どんな
// レアリティ名が valid か」がずれ、同じ名前が片方では保存できて片方では
// できない、という不整合が生じるため。
import {
  MAX_RARITY_KEY_LENGTH,
  RARITY_CONTROL_CHAR_REGEX as CONTROL_CHAR_REGEX,
  RARITY_BIDI_OVERRIDE_REGEX as BIDI_OVERRIDE_REGEX,
} from "@/lib/constants";

/**
 * 表示段階の最大数。問い合わせ #1728 の例（1段階目 → 2段階目 → 3段階目）
 * に合わせた上限で、これ以上は作らない（YAGNI: 4段階目以降の訴求は未定義）。
 * Maximum number of display tiers (matches the "1st → 2nd → 3rd stage"
 * example in the original request).
 */
export const MAX_DUPLICATE_TIERS = 3;

/**
 * しきい値（所有枚数）の下限。2 未満は設定できない。
 *
 * 所有枚数 1 は「そのカードを1枚だけ持っている」状態であり「被り」ではない
 * ため、1段階目のしきい値が 1 だと全カードが最初から段階表示されてしまう。
 * Minimum owned-copy threshold. A count of 1 is not a duplicate at all, so
 * allowing 1 would badge every single owned card from the start.
 */
export const MIN_DUPLICATE_TIER_THRESHOLD = 2;

/**
 * しきい値の上限。DB の CHECK 制約と同じ上限で、整数 4 桁までに制限する。
 * Maximum owned-copy threshold (mirrored by the DB CHECK constraint).
 */
export const MAX_DUPLICATE_TIER_THRESHOLD = 9999;

/**
 * 設定エントリ（レアリティ）数の上限。既定レアリティ4種 + カスタムレアリティ
 * 上限50件 (constants.ts の MAX_CUSTOM_RARITIES)。DB の CHECK 制約と同じ上限。
 * Cap on configured rarities: 4 defaults + MAX_CUSTOM_RARITIES(50) customs.
 */
export const MAX_DUPLICATE_TIER_ENTRIES = 54;

/** レアリティ名 1 エントリ分のしきい値（厳密増加する所有枚数の配列）。 */
export type DuplicateTierThresholds = number[];

/** レアリティ名 → そのレアリティのしきい値配列。エントリが無いレアリティは段階表示しない。 */
export type DuplicateDisplayTiers = Record<string, DuplicateTierThresholds>;

/**
 * 「段階表示をしない」ことを表す段階番号。0 のとき視聴者側はバッジを出さない。
 * Tier 0 = no tier configured for this rarity/count = no badge at all.
 */
export const NO_DUPLICATE_TIER = 0;

/**
 * しきい値配列を正規化する。有効な配列だけを返し、それ以外は null。
 *
 * 有効 = 長さ 1..MAX_DUPLICATE_TIERS の配列で、全要素が
 * [MIN_DUPLICATE_TIER_THRESHOLD, MAX_DUPLICATE_TIER_THRESHOLD] の整数、
 * かつ厳密増加（同値・逆順は弾く）。
 *
 * 厳密増加を必須にする理由: しきい値が同値・逆順だと「何枚で何段階になるか」
 * が一意に定まらない。例えば [4, 2] は「2枚で2段階、4枚で1段階」という
 * 矛盾した解釈が可能になり、配信者が設定した段階設計が表示側で崩れる。
 * 黙って並べ替えると「入力と違う段階が保存された」ことになるため、
 * 不正入力として扱う（呼び出し側が 400 / 保存しない方向に倒す）。
 *
 * Normalize a threshold list. Returns the list only when it is a strictly
 * increasing run of 1..MAX_DUPLICATE_TIERS integers inside the allowed range;
 * anything else (non-array, wrong length, non-integer, out of range,
 * duplicate or descending values) is null. Strictly increasing is mandatory
 * because otherwise "how many copies for which tier" is ambiguous — e.g.
 * [4, 2] could be read as "2 copies → tier 2, 4 copies → tier 1".
 */
export function normalizeDuplicateTierThresholds(value: unknown): DuplicateTierThresholds | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 1 || value.length > MAX_DUPLICATE_TIERS) return null;

  const thresholds: number[] = [];
  for (const raw of value) {
    if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
    if (raw < MIN_DUPLICATE_TIER_THRESHOLD || raw > MAX_DUPLICATE_TIER_THRESHOLD) {
      return null;
    }
    if (thresholds.length > 0 && raw <= thresholds[thresholds.length - 1]) return null;
    thresholds.push(raw);
  }

  return thresholds;
}

/**
 * 保存入力（API body）の検証。`null` は「全エントリをクリア（機能OFF）」
 * として常に許可する。
 *
 * - オブジェクト以外（配列含む）は不正。
 * - キーは rarity_weights (#578) と同じ規則: trim + Unicode NFC 正規化後に
 *   長さ 1..40、制御文字 / Bidi override を禁止する。カタログ所属の検証は
 *   行わない（未知のレアリティ名はどのカードの rarity にも一致せず、
 *   表示上は単に無効になるため、保存を拒否する理由にならない。
 *   設定UI も既定 + custom_rarities の行しか出さない）。
 * - 正規化(trim/NFC)後にキーが重複する場合は不正（黙ってマージすると
 *   段階設計が意図せず変わる）。
 * - 値は normalizeDuplicateTierThresholds を通ること。
 *
 * Validate the settings payload. `null` clears every entry (feature off).
 * Keys are validated by shape only, exactly like rarity_weights (#578) does:
 * an unknown rarity name simply never matches a card, so there is nothing to
 * protect by rejecting it.
 */
export function validateDuplicateDisplayTiers(
  value: unknown
): { ok: true; value: DuplicateDisplayTiers | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_DUPLICATE_TIER_ENTRIES) return { ok: false };

  const normalized: DuplicateDisplayTiers = {};
  for (const [rawKey, rawThresholds] of entries) {
    const key = rawKey.trim().normalize("NFC");
    if (key.length < 1 || key.length > MAX_RARITY_KEY_LENGTH) {
      return { ok: false };
    }
    if (CONTROL_CHAR_REGEX.test(key) || BIDI_OVERRIDE_REGEX.test(key)) {
      return { ok: false };
    }
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      return { ok: false };
    }

    const thresholds = normalizeDuplicateTierThresholds(rawThresholds);
    if (thresholds === null) return { ok: false };

    normalized[key] = thresholds;
  }

  return { ok: true, value: normalized };
}

/**
 * DB から読んだ値を、安全なマップへ縮退させる。デプロイ窓で列が未作成の間は
 * `undefined`、手動編集等で壊れた値が入っていても、有効なエントリだけを残す
 * （表示側が例外で落ちないことを優先する）。壊れたレアリティのエントリを
 * 落としても、そのカードは段階表示されないだけなので情報損失は表示範囲に閉じる。
 *
 * Fail-closed normalization for reads: keeps only entries that pass
 * validation so a corrupt row can never throw inside the viewer page.
 */
export function sanitizeDuplicateDisplayTiers(value: unknown): DuplicateDisplayTiers {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const sanitized: DuplicateDisplayTiers = {};
  for (const [key, rawThresholds] of Object.entries(value as Record<string, unknown>)) {
    const thresholds = normalizeDuplicateTierThresholds(rawThresholds);
    if (thresholds !== null) sanitized[key] = thresholds;
  }
  return sanitized;
}

/**
 * 対象カードの表示段階（0..MAX_DUPLICATE_TIERS）を解決する。
 *
 * 所有枚数が最後のしきい値以上なら最大段階、それ以上は無い。未設定・
 * しきい値未満・未所持（count 0）の場合は 0（= バッジを出さない）。
 *
 * 例: thresholds = [2, 5] のとき
 *   count 1 → 0 / count 2..4 → 1 / count 5 以上 → 2
 *
 * Resolve the display tier for one card. Returns 0 when the rarity has no
 * configuration or the owned count has not reached the first threshold.
 */
export function resolveDuplicateTier(
  tiers: DuplicateDisplayTiers | null | undefined,
  rarity: string,
  count: number
): number {
  const thresholds = tiers?.[rarity];
  if (!thresholds || !Number.isFinite(count)) return NO_DUPLICATE_TIER;

  let tier = NO_DUPLICATE_TIER;
  for (const threshold of thresholds) {
    if (count >= threshold) {
      tier += 1;
    } else {
      // しきい値は厳密増加で保存されるため、1つ届かなければ以降も届かない。
      break;
    }
  }
  return tier;
}

/**
 * 段階ごとの視聴者側バッジの見た目。段階が上がるほど枠を強くする。
 * 色はレアリティバッジと衝突しない紫系（コレクションのアクセント色）で統一する。
 *
 * Per-tier badge styling for the viewer side. The ring gets stronger with
 * each tier so the escalation is visible at a glance; the hue stays on the
 * collection's purple accent so it never competes with the rarity badge.
 */
export const DUPLICATE_TIER_BADGE_CLASSES: Record<number, string> = {
  1: "bg-purple-500/15 text-purple-200 ring-1 ring-inset ring-purple-400/30",
  2: "bg-purple-500/25 text-purple-100 ring-1 ring-inset ring-purple-300/50",
  3: "bg-purple-400/35 text-white ring-1 ring-inset ring-purple-200/70",
};

/**
 * 段階に対応するバッジクラスを返す。段階 0（未設定・しきい値未満）では
 * 空文字を返すので、呼び出し側は truthy 判定だけでバッジの出し分けができる。
 */
export function duplicateTierBadgeClass(tier: number): string {
  return DUPLICATE_TIER_BADGE_CLASSES[tier] ?? "";
}

/**
 * 段階に対応するカード枠のリングクラス。段階 0 では空文字。
 * 段階 1 → 2 → 3 で濃さと太さを両方上げ、所有枚数の到達度が一瞬で判別できる
 * ようにする（段階 1 と 2 が同一クラスだと「2段階目だけ見分けが付かない」ため、
 * 濃度差を必ず付ける）。
 *
 * 既存の `isInactive`（配布停止中）のリングとは排他（CollectionCard 側で
 * 段階表示を優先して後面のリングは畳む）。重なった場合は active 側の情報が
 * 視認できる級を取る。
 */
export function duplicateTierFrameClass(tier: number): string {
  if (tier <= 0) return "";
  if (tier >= 3) return "ring-2 ring-purple-400";
  if (tier === 2) return "ring-1 ring-purple-400/70";
  return "ring-1 ring-purple-400/40";
}
