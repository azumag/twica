import { getCollectedStreamerIds } from "@/lib/collected-streamers";
import {
  listTradeOffersByCollection,
  TRADE_PAGE_SIZE,
  type TradeCollectionKind,
  type TradeCollectionSort,
  type TradeOfferDto,
  type TradeStreamerSummary,
} from "@/lib/trade";
import {
  listTradeAuctionsByCollection,
  type TradeAuctionDto,
} from "@/lib/trade-auction";

/**
 * ハブ /trade の「コレクション別出品」の合成 (#2079)。
 *
 * サービス層を分けている理由:
 *   - 出品とオークションはテーブルも可視性条件も別で、それぞれ1クエリで取る。
 *   - 合成（コレクションの並び・同じ配信者の2種類のマージ）は DB に依存しない
 *     純粋な処理なので、単体テストで順序を固定できる。
 *
 * コレクションの並びは「最新の出品の作成日時が新しい順、同じなら配信者 id の
 * 昇順」で決定的にする。最新日時は、プレビュー件数 (src/lib/trade.ts の
 * TRADE_COLLECTION_PREVIEW_SIZE) ではなく各配置先の全件の MAX
 * (SQL の MAX OVER) を使う。6件目以降に新しい出品があっても順位が変わらない。
 */
export type TradeCollectionSection = {
  streamer: TradeStreamerSummary;
  offers: TradeOfferDto[];
  /** そのコレクションに配置された出品の全件数（プレビュー件数ではない）。 */
  offerTotal: number;
  auctions: TradeAuctionDto[];
  /** そのコレクションに配置されたオークションの全件数。 */
  auctionTotal: number;
  /** 2種類を合わせた最新の出品作成日時（コレクションの並びに使う）。 */
  latestCreatedAt: string;
};

function timeOf(value: string): number {
  const time = Date.parse(value);
  // 不正な日時は「不明」として最古に倒す。ID の決着は常に固定なので、
  // データが壊れていても並びは決定的になる。
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/**
 * コレクションの並びを決める（元の配列は変更しない）。
 *
 * 主キー: 最新の出品作成日時の降順。同順位: 配信者 id の昇順。
 * 表示名は使わない（同じ表示名の配信者がいても id で決定的にするため）。
 */
export function sortTradeCollectionSections<
  T extends { streamer: { id: string }; latestCreatedAt: string },
>(sections: readonly T[]): T[] {
  return [...sections].sort((a, b) => {
    const aTime = timeOf(a.latestCreatedAt);
    const bTime = timeOf(b.latestCreatedAt);
    if (aTime !== bTime) {
      // 新しい順。両方 -Infinity のときはここに来ない。
      return bTime - aTime;
    }
    if (a.streamer.id === b.streamer.id) return 0;
    return a.streamer.id < b.streamer.id ? -1 : 1;
  });
}

function mergeSection(
  sections: Map<string, TradeCollectionSection>,
  streamer: TradeStreamerSummary,
  latestCreatedAt: string,
): TradeCollectionSection {
  const existing = sections.get(streamer.id);
  if (existing) {
    if (timeOf(latestCreatedAt) > timeOf(existing.latestCreatedAt)) {
      existing.latestCreatedAt = latestCreatedAt;
    }
    return existing;
  }
  const created: TradeCollectionSection = {
    streamer,
    offers: [],
    offerTotal: 0,
    auctions: [],
    auctionTotal: 0,
    latestCreatedAt,
  };
  sections.set(streamer.id, created);
  return created;
}

/**
 * ハブの初期表示。出品とオークションを並列に1回ずつ読み、コレクション単位に
 * マージする。0件なら空配列（画面は空状態を出す）。
 */
export async function listTradeCollections(input: {
  twitchUserId: string;
  sort: TradeCollectionSort;
}): Promise<TradeCollectionSection[]> {
  const [offerGroups, auctionGroups] = await Promise.all([
    listTradeOffersByCollection({
      twitchUserId: input.twitchUserId,
    }),
    listTradeAuctionsByCollection({
      twitchUserId: input.twitchUserId,
      sort: input.sort,
    }),
  ]);

  const sections = new Map<string, TradeCollectionSection>();
  for (const group of offerGroups) {
    const section = mergeSection(sections, group.streamer, group.latestCreatedAt);
    section.offers = group.offers;
    section.offerTotal = group.total;
  }
  for (const group of auctionGroups) {
    const section = mergeSection(sections, group.streamer, group.latestCreatedAt);
    section.auctions = group.auctions;
    section.auctionTotal = group.total;
  }
  return sortTradeCollectionSections([...sections.values()]);
}

export type TradeCollectionPageResult =
  | {
    kind: "offer";
    streamer: TradeStreamerSummary | null;
    offers: TradeOfferDto[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  }
  | {
    kind: "auction";
    streamer: TradeStreamerSummary | null;
    auctions: TradeAuctionDto[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  };

/**
 * 展開 API の1ページ。折りたたみ時と同じ listTradeOffersByCollection /
 * listTradeAuctionsByCollection を、配信者1件・TRADE_PAGE_SIZE 件で呼ぶ。
 * これにより、プレビューと展開後の先頭 TRADE_PAGE_SIZE 件が同じ条件・同じ並び・同じ DTO で
 * 作られる（別実装にすると可視性や件数がずれる）。
 *
 * 閲覧者がそのコレクションを持っていない場合は null（API は 404）。
 * 持っているが0件の場合は空のページを返す（404 と混同しない）。
 */
export async function listTradeCollectionPage(input: {
  twitchUserId: string;
  streamerId: string;
  kind: TradeCollectionKind;
  sort: TradeCollectionSort;
  page: number;
}): Promise<TradeCollectionPageResult | null> {
  const owned = await getCollectedStreamerIds(input.twitchUserId, input.streamerId);
  if (owned.size === 0) return null;

  if (input.kind === "offer") {
    const [group] = await listTradeOffersByCollection({
      twitchUserId: input.twitchUserId,
      streamerId: input.streamerId,
      page: input.page,
    });
    const offers = group?.offers ?? [];
    const total = group?.total ?? 0;
    const offset = (input.page - 1) * TRADE_PAGE_SIZE;
    return {
      kind: "offer",
      streamer: group?.streamer ?? null,
      offers,
      total,
      page: input.page,
      pageSize: TRADE_PAGE_SIZE,
      hasMore: total > offset + offers.length,
    };
  }

  const [group] = await listTradeAuctionsByCollection({
    twitchUserId: input.twitchUserId,
    streamerId: input.streamerId,
    sort: input.sort,
    page: input.page,
  });
  const auctions = group?.auctions ?? [];
  const total = group?.total ?? 0;
  const offset = (input.page - 1) * TRADE_PAGE_SIZE;
  return {
    kind: "auction",
    streamer: group?.streamer ?? null,
    auctions,
    total,
    page: input.page,
    pageSize: TRADE_PAGE_SIZE,
    hasMore: total > offset + auctions.length,
  };
}

