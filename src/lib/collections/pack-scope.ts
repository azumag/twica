// Issue #1994: カードパック（collection）による抽選プール絞り込み条件の共通化。
//
// 1つのチャネルポイント報酬に複数パックを割り当てられるようになったため、
// 「collection_name がこのパック集合に属する」条件を、ガチャの抽選プール読み取り
// （src/lib/services/gacha.ts の loadPgCards）から1つの関数で組み立てる。
// 条件の組み立てを1か所に置くことで、DEFAULT_PACK_SENTINEL（未分類カード =
// collection_name IS NULL）の展開規則が経路ごとにずれる事故を防ぐ。
import { eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";

/**
 * パック集合 `names` に属するカードだけを残す WHERE 条件を返す。
 *
 * - `[]` → undefined（絞り込みなし = 全カード。呼び出し側は条件を足さない）
 * - 1要素 → 旧実装と同一の `eq(col, name)` / `isNull(col)`。単一パック経路の SQL を
 *   一切変えない（既存の性能特性・テスト・本番挙動を維持する）ため、1要素では
 *   IN を使わない。
 * - 2要素以上 → `col IN (...)`。DEFAULT_PACK_SENTINEL は IN の中に入れず
 *   `OR col IS NULL` へ展開する。センチネルは「パック名が文字列 "__default__" の
 *   カード」ではなく「どのパックにも属さない（NULL）カード」を意味するため、
 *   IN に入れると未分類カードが1枚も当たらない誤った条件になる。
 *
 * 呼び出し側は事前に重複除去済みの配列を渡す前提（resolveEffectiveRewardPackNames /
 * resolveCollectionNamesField が保証する）。
 */
export function buildPackScopePredicate(
  column: PgColumn,
  names: readonly string[]
): SQL | undefined {
  if (names.length === 0) return undefined;

  const includeDefaultPack = names.includes(DEFAULT_PACK_SENTINEL);
  const namedPacks = names.filter((name) => name !== DEFAULT_PACK_SENTINEL);

  if (namedPacks.length === 0) {
    return isNull(column);
  }

  const namedPredicate = namedPacks.length === 1
    ? eq(column, namedPacks[0])
    : inArray(column, namedPacks);

  return includeDefaultPack ? or(namedPredicate, isNull(column)) : namedPredicate;
}
