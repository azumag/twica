// #1765 フォローアップ: アルバム表示の「並び (N×N)」と、配信者がコレクション
// (カードパック) ごとに指定する既定値の純粋ロジック。
//
// collection-utils.ts / collection-packs.ts と同じく DB・React 非依存とし、
// Server Component / API route / Client Component の全てから同じ規則で
// 解決できるようにする（表示側と保存側で検証規則がずれないことが要件）。
//
// Follow-up to #1765: pure rules for the album grid size (N×N) and the
// streamer-configured per-collection (pack) defaults. Intentionally pure so the
// viewer page, the settings API and the settings UI share exactly one rule set.

import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";

/**
 * 「すべてのパック」(パック絞り込み未選択) を表す予約キー。
 * 予約キーは `__` 始まりで、実パック名としては登録できない
 * (validatePackName が `__` 接頭辞を拒否するため衝突しない)。
 *
 * Reserved scope key for "all packs" (no pack filter selected). Real pack names
 * can never start with `__`, so this cannot collide with a catalog entry.
 */
export const ALBUM_ALL_PACKS_KEY = "__all__";

/** 1ページのアルバム枠は N×N。N の下限・上限（DB CHECK と同一）。 */
export const ALBUM_GRID_SIZE_MIN = 3;
export const ALBUM_GRID_SIZE_MAX = 12;

/** 未設定時の並び（従来の 3×3 と同じ）。 */
export const DEFAULT_ALBUM_GRID_SIZE = 3;

/** ビューア側の見出しに出すプリセット（任意の N も選択可能）。 */
export const ALBUM_GRID_SIZE_PRESETS = [3, 6, 9] as const;

/** 選択可能な N の一覧（昇順）。select の option 生成に使う。 */
export const ALBUM_GRID_SIZES: number[] = Array.from(
  { length: ALBUM_GRID_SIZE_MAX - ALBUM_GRID_SIZE_MIN + 1 },
  (_, index) => ALBUM_GRID_SIZE_MIN + index
);

/**
 * 1パックあたりの設定エントリ上限。実パックカタログの上限（50）+ 予約キー
 * (「すべて」「デフォルト」) + 余裕1。DB 側の検証関数と同じ上限。
 */
export const MAX_ALBUM_GRID_SIZE_ENTRIES = 52;

/** コレクションページの初期表示モード。 */
export const ALBUM_DEFAULT_VIEWS = ["grid", "album"] as const;
export type AlbumDefaultView = (typeof ALBUM_DEFAULT_VIEWS)[number];

/** パックのスコープキー → そのスコープの既定 N。 */
export type AlbumGridSizeMap = Record<string, number>;

/**
 * スコープキーが予約キー（すべて / デフォルト）かどうか。
 */
export function isReservedAlbumScopeKey(key: string): boolean {
  return key === ALBUM_ALL_PACKS_KEY || key === DEFAULT_PACK_SENTINEL;
}

/**
 * 生の値を有効な N へ正規化する。整数かつ [MIN, MAX] のときだけ値を返し、
 * それ以外（小数・文字列・範囲外・NaN）は null。呼び出し側は null を
 * 「不正入力」か「未設定」のどちらとして扱うかを文脈で決める。
 */
export function normalizeAlbumGridSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < ALBUM_GRID_SIZE_MIN || value > ALBUM_GRID_SIZE_MAX) return null;
  return value;
}

/**
 * 保存入力（API body）の検証。`null` は「全エントリをクリア」として許可する。
 *
 * - オブジェクト以外（配列含む）は不正。
 * - キーは予約キーか `catalog`（保存後の実効パックカタログ）に登録済みの名前のみ。
 * - 値は normalizeAlbumGridSize を通ること。
 *
 * catalog を省略した場合は予約キーのみ許可する（カタログ未確定の呼び出しで
 * 任意の名前を保存してしまわないための fail-closed）。
 */
export function validateAlbumGridSizeMap(
  value: unknown,
  catalog: string[]
): { ok: true; value: AlbumGridSizeMap | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ALBUM_GRID_SIZE_ENTRIES) return { ok: false };

  const normalized: AlbumGridSizeMap = {};
  for (const [key, raw] of entries) {
    if (!isReservedAlbumScopeKey(key) && !catalog.includes(key)) {
      return { ok: false };
    }
    const size = normalizeAlbumGridSize(raw);
    if (size === null) return { ok: false };
    normalized[key] = size;
  }

  return { ok: true, value: normalized };
}

/**
 * カタログ縮小後に残った無効キーを落とす（__default__ / __all__ は常に保持）。
 * pack_rarity_weights の prune と同じ規則: カタログから消えたパックの設定は
 * 保存し続けない。
 */
export function pruneAlbumGridSizeMap(
  value: AlbumGridSizeMap,
  catalog: string[]
): AlbumGridSizeMap {
  const pruned: AlbumGridSizeMap = {};
  for (const [key, size] of Object.entries(value)) {
    if (isReservedAlbumScopeKey(key) || catalog.includes(key)) {
      pruned[key] = size;
    }
  }
  return pruned;
}

/**
 * DB から読んだ値を、安全なマップへ縮退させる。デプロイ窓で列が未作成の間は
 * `undefined`、手動編集等で壊れた値が入っていても、有効なエントリだけを残す
 * （表示側が例外で落ちないことを優先する）。
 */
export function sanitizeAlbumGridSizeMap(value: unknown): AlbumGridSizeMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized: AlbumGridSizeMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const size = normalizeAlbumGridSize(raw);
    if (size !== null) sanitized[key] = size;
  }
  return sanitized;
}

/**
 * スコープの実効 N を解決する。
 * そのスコープの指定 → 「すべてのパック」の指定 → 既定 3、の順にフォールバック
 * する（配信者が「すべて」だけ設定すれば全パックに効く）。
 */
export function resolveAlbumGridSize(
  sizes: AlbumGridSizeMap | null | undefined,
  scopeKey: string
): number {
  return (
    normalizeAlbumGridSize(sizes?.[scopeKey]) ??
    normalizeAlbumGridSize(sizes?.[ALBUM_ALL_PACKS_KEY]) ??
    DEFAULT_ALBUM_GRID_SIZE
  );
}

/**
 * 生の値を初期表示モードへ正規化する。不明値は fail-closed で従来のカード
 * グリッド表示に倒す（デプロイ窓・破損データで表示が勝手に切り替わらない）。
 */
export function normalizeAlbumDefaultView(value: unknown): AlbumDefaultView {
  return value === "album" ? "album" : "grid";
}
