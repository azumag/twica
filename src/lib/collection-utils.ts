import { getRarityRank } from "@/lib/rarity";
import type { Card } from "@/types/database";

export type CollectionSortMode = "rarity" | "number";

type SortableCollectionCard = Pick<Card, "id" | "rarity" | "created_at"> & {
  collectionNumber?: number;
};

type NumberableCollectionCard = Pick<Card, "id" | "created_at"> & {
  card_number?: number | null;
};

/**
 * Sort owned cards for collection views.
 * Defaults to rarity first (legendary first), with optional encyclopedia number order.
 */
export function sortCollectedCards<T extends SortableCollectionCard>(
  cards: T[],
  mode: CollectionSortMode = "rarity"
): T[] {
  return [...cards].sort((a, b) => {
    if (mode === "number") {
      const numberDiff =
        (a.collectionNumber ?? Number.MAX_SAFE_INTEGER) -
        (b.collectionNumber ?? Number.MAX_SAFE_INTEGER);
      if (numberDiff !== 0) return numberDiff;
    }

    // getRarityRank: 未知の(カスタム)レアリティはビルトインより後ろに来るよう
    // Number.POSITIVE_INFINITY を返す（Issue #505、gacha-sound-rules.ts と同じ考え方）
    const rarityDiff = getRarityRank(a.rarity) - getRarityRank(b.rarity);
    if (rarityDiff !== 0) return rarityDiff;

    const createdAtDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (createdAtDiff !== 0) return createdAtDiff;

    return a.id.localeCompare(b.id);
  });
}

/**
 * Build stable encyclopedia-style card numbers for a streamer's cards.
 * Manually assigned card_number values are honored first.
 * Remaining cards are filled into the next available numbers by oldest created_at first,
 * and duplicate owned-card rows are ignored.
 */
export function createCollectionNumberMap<T extends NumberableCollectionCard>(
  cards: T[]
): Map<string, number> {
  const uniqueCards = new Map<string, T>();
  for (const card of cards) {
    const existing = uniqueCards.get(card.id);
    if (
      !existing ||
      new Date(card.created_at).getTime() < new Date(existing.created_at).getTime()
    ) {
      uniqueCards.set(card.id, card);
    }
  }

  const sortedCards = [...uniqueCards.values()].sort((a, b) => {
    const createdAtDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (createdAtDiff !== 0) return createdAtDiff;

    return a.id.localeCompare(b.id);
  });

  const numberMap = new Map<string, number>();
  const usedNumbers = new Set<number>();

  for (const card of sortedCards) {
    if (
      typeof card.card_number === "number" &&
      Number.isInteger(card.card_number) &&
      card.card_number > 0 &&
      !usedNumbers.has(card.card_number)
    ) {
      numberMap.set(card.id, card.card_number);
      usedNumbers.add(card.card_number);
    }
  }

  let nextNumber = 1;
  for (const card of sortedCards) {
    if (numberMap.has(card.id)) continue;
    while (usedNumbers.has(nextNumber)) {
      nextNumber++;
    }
    numberMap.set(card.id, nextNumber);
    usedNumbers.add(nextNumber);
  }

  return numberMap;
}

/**
 * Count unique owned cards that are still active for progress calculations.
 */
export function countOwnedActiveCardTypes<T extends { id: string }>(
  cards: T[],
  activeCardIds: Iterable<string>
): number {
  const activeIdSet = activeCardIds instanceof Set ? activeCardIds : new Set(activeCardIds);

  return new Set(
    cards
      .filter((card) => activeIdSet.has(card.id))
      .map((card) => card.id)
  ).size;
}

/**
 * マイコレクション一覧(/dashboard/collection)の配信者の並び替えモード (#1953)。
 *
 * - recent: 最近カードを獲得した配信者が先(既定)
 * - name: 配信者の表示名順
 * - completion: コンプ率(アクティブカードの所持率)の高い順
 *
 * カード単位の CollectionSortMode("rarity" | "number")とは対象が違う(こちらは
 * 配信者単位)ため、別の型として分けている。
 */
export type StreamerCollectionSortMode = "recent" | "name" | "completion";

/**
 * 配信者コレクションの並び替えの向き (#2032)。`asc` = 昇順、`desc` = 降順。
 * 「昇順」の意味はモードごとに異なる: name は名前の若い順、recent は獲得が古い順、
 * completion はコンプ率の低い順。既定の向きはモードごとに決まっており、
 * URL クエリを付けない既存の URL・ブックマークは従来どおりの並びになる。
 */
export type StreamerCollectionSortOrder = "asc" | "desc";

/** 各モードの既定の向き（#1954 時点の固定の向きと同じ）。 */
export const DEFAULT_STREAMER_COLLECTION_ORDER: Record<
  StreamerCollectionSortMode,
  StreamerCollectionSortOrder
> = {
  recent: "desc",
  name: "asc",
  completion: "desc",
};

export const DEFAULT_STREAMER_COLLECTION_SORT: StreamerCollectionSortMode = "recent";

const STREAMER_COLLECTION_SORT_MODES: readonly StreamerCollectionSortMode[] = [
  "recent",
  "name",
  "completion",
];

/**
 * URL クエリ `?sort=` の生の値を並び替えモードへ正規化する。
 *
 * クエリは利用者が自由に書き換えられるため、未知の値・空文字・`?sort=a&sort=b` の
 * ような配列は黙って既定値へ落とす(エラーページにはしない)。許可リストとの
 * 完全一致だけを通すので、値をそのまま HTML / リンクへ埋め込むことも無い。
 */
export function parseStreamerCollectionSort(
  value: string | string[] | undefined
): StreamerCollectionSortMode {
  if (typeof value !== "string") return DEFAULT_STREAMER_COLLECTION_SORT;
  return (STREAMER_COLLECTION_SORT_MODES as readonly string[]).includes(value)
    ? (value as StreamerCollectionSortMode)
    : DEFAULT_STREAMER_COLLECTION_SORT;
}

/**
 * URL クエリ `?order=` の生の値を並び替えの向きへ正規化する (#2032)。
 *
 * parseStreamerCollectionSort と同じ方針: 許可リスト("asc" | "desc")との完全一致だけを
 * 通し、未知の値・未指定・配列は黙ってそのモードの既定の向きへ落とす。向きの既定は
 * モードに依存するため mode を引数に取る。
 */
export function parseStreamerCollectionOrder(
  value: string | string[] | undefined,
  mode: StreamerCollectionSortMode
): StreamerCollectionSortOrder {
  return value === "asc" || value === "desc"
    ? value
    : DEFAULT_STREAMER_COLLECTION_ORDER[mode];
}

type SortableStreamerCollection = {
  streamer: { id: string; twitch_display_name: string };
  totalActive: number;
  ownedActive: number;
};

/**
 * アクティブカードの所持率(0〜1)。アクティブカードが 0 枚の配信者は分母が無く
 * 比較できないため 0 とする(page 側の進捗バーの表示 0% と同じ扱い)。
 */
function completionRatio(item: Pick<SortableStreamerCollection, "totalActive" | "ownedActive">): number {
  if (item.totalActive <= 0) return 0;
  return Math.min(1, Math.max(0, item.ownedActive / item.totalActive));
}

/** ISO 文字列などを epoch ms にする。null / 不正値は NaN(= 獲得日時不明)。 */
function toEpochMs(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

/**
 * 配信者コレクションの一覧を並び替える(元の配列は変更しない)。
 *
 * 比較関数は全モードで「主キー → 表示名 → streamer.id」の順に決着をつけ、
 * 入力順や DB の返却順に依存しない決定的な並びにする(再読み込みや
 * router.refresh() のたびにカードの位置が入れ替わるのを防ぐ)。
 *
 * @param lastObtainedAtByStreamer 配信者IDごとの最終カード獲得日時(ISO文字列)。
 *   recent 以外では使わない。取得に失敗した場合は空の Map を渡してよく、
 *   日時不明の配信者は最後尾にまとめて表示名順で並ぶ。
 * @param order 並びの向き (#2032)。省略時はモードの既定の向き
 *   (DEFAULT_STREAMER_COLLECTION_ORDER)で、従来の並びと同じになる。
 *   反転するのは各モードの主キーだけで、同順位の決着(表示名→id)は向きに
 *   依らず固定のままにして決定的な並びを保つ。recent で獲得日時が不明の
 *   配信者は、向きによらず常に末尾に置く(「不明」を「最古/最新」と解釈しない)。
 */
export function sortStreamerCollections<T extends SortableStreamerCollection>(
  items: readonly T[],
  mode: StreamerCollectionSortMode,
  lastObtainedAtByStreamer: ReadonlyMap<string, string | null> = new Map(),
  order: StreamerCollectionSortOrder = DEFAULT_STREAMER_COLLECTION_ORDER[mode]
): T[] {
  const nameDiff = (a: T, b: T): number =>
    // "ja" ロケールで比較し、日本語名(かな/漢字)の並びを自然にする。
    a.streamer.twitch_display_name.localeCompare(b.streamer.twitch_display_name, "ja");
  const idDiff = (a: T, b: T): number =>
    // localeCompare が 0 を返す(照合上同一)名前同士は id で最終決着させる。
    a.streamer.id === b.streamer.id ? 0 : a.streamer.id < b.streamer.id ? -1 : 1;
  const byNameThenId = (a: T, b: T): number => nameDiff(a, b) || idDiff(a, b);

  return [...items].sort((a, b) => {
    if (mode === "recent") {
      const aMs = toEpochMs(lastObtainedAtByStreamer.get(a.streamer.id));
      const bMs = toEpochMs(lastObtainedAtByStreamer.get(b.streamer.id));
      const aKnown = !Number.isNaN(aMs);
      const bKnown = !Number.isNaN(bMs);
      // 日時不明(取得失敗・NULL)は「古い」ではなく「判断不能」なので、既知の配信者より後ろへ。
      // この末尾送りは向きを反転しても変えない。
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (aKnown && bKnown && aMs !== bMs)
        return order === "asc" ? aMs - bMs : bMs - aMs;
    } else if (mode === "completion") {
      const ratioDiff =
        order === "asc"
          ? completionRatio(a) - completionRatio(b)
          : completionRatio(b) - completionRatio(a);
      if (ratioDiff !== 0) return ratioDiff;
    } else {
      // name: 向きは主キー(名前)だけに適用し、id の決着は固定のままにする。
      const diff = nameDiff(a, b);
      if (diff !== 0) return order === "asc" ? diff : -diff;
      return idDiff(a, b);
    }
    return byNameThenId(a, b);
  });
}
