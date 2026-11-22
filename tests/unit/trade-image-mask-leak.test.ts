import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db/client";

/**
 * #2070: 漏れ検出（サービス層）。
 *
 * 名前だけ公開の配信者（show_unowned_cards=true, details=false,
 * trade_unowned_card_names_visible=true）では、未所持カードの名前とレアリティは
 * 見せてよいが画像は見せない。snapshot 列はフルのまま保存されるので、読み出し時に
 * 各サービス関数が imageUrl を落とさないと、API 応答の JSON から画像 URL が漏れる。
 *
 * ここでは「画像が見えるカード ID の集合」を返すマスク用 SELECT だけを空にして、
 * 各関数の戻り値を JSON.stringify し、秘密の URL が含まれないことを確かめる。
 * 所持している / 詳細公開の場合は画像が残ることも同じ形で確認する。
 *
 * 実 SQL の可視性判定（所持・詳細公開・is_active を問わない画像ルール）は
 * tests/integration/trade-visibility-pg.test.ts / trade-auction-pg.test.ts の
 * NAMEONLY fixture が実 PostgreSQL で検証する。
 */
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const SECRET = "https://secret.example/unowned-card.png";
/** A second secret so a test can distinguish "offered image kept" from "bid masked". */
const BID_SECRET = "https://secret.example/bid-card.png";

const ID = {
  offer: "10000000-0000-4000-8000-000000000001",
  offerer: "20000000-0000-4000-8000-000000000001",
  viewer: "20000000-0000-4000-8000-000000000002",
  seller: "20000000-0000-4000-8000-000000000003",
  bidder: "20000000-0000-4000-8000-000000000004",
  offeredCopy: "30000000-0000-4000-8000-000000000001",
  offeredCard: "40000000-0000-4000-8000-000000000001",
  wantedCard: "40000000-0000-4000-8000-000000000002",
  streamer: "50000000-0000-4000-8000-000000000001",
  request: "60000000-0000-4000-8000-000000000001",
  auction: "70000000-0000-4000-8000-000000000001",
  bid: "80000000-0000-4000-8000-000000000001",
};

const secretSnapshot = (name: string) => ({
  name,
  rarity: "legendary",
  imageUrl: SECRET,
});

const OFFER_ROW = {
  id: ID.offer,
  offerer_user_id: ID.offerer,
  offered_user_card_id: ID.offeredCopy,
  offered_card_id: ID.offeredCard,
  offered_streamer_id: ID.streamer,
  wanted_card_id: ID.wantedCard,
  wanted_streamer_id: ID.streamer,
  offered_card_snapshot: secretSnapshot("Offered Name"),
  wanted_card_snapshot: secretSnapshot("Wanted Name"),
  wanted_quantity: 1,
  is_cross_channel: false,
  status: "open",
  accepted_by_user_id: null,
  accepted_user_card_id: null,
  completed_at: null,
  request_id: ID.request,
  accepted_request_id: null,
  created_at: "2026-10-04T00:00:00.000Z",
  updated_at: "2026-10-04T00:00:00.000Z",
};

const STREAMER = {
  id: ID.streamer,
  twitchUsername: "channel",
  twitchDisplayName: "Channel",
  twitchProfileImageUrl: null,
};
const USER = {
  id: ID.offerer,
  twitchUsername: "offerer",
  twitchDisplayName: "Offerer",
  twitchProfileImageUrl: null,
};
const NO_USER = { id: null, twitchUsername: null, twitchDisplayName: null, twitchProfileImageUrl: null };

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    offer: OFFER_ROW,
    viewerUserId: ID.viewer,
    offeredStreamer: STREAMER,
    wantedStreamer: STREAMER,
    offerer: USER,
    acceptedBy: NO_USER,
    acceptState: null,
    tradeableState: false,
    ...overrides,
  };
}

const AUCTION_ROW = {
  auction: {
    id: ID.auction,
    seller_user_id: ID.seller,
    offered_user_card_id: ID.offeredCopy,
    offered_card_id: ID.offeredCard,
    offered_streamer_id: ID.streamer,
    offered_card_snapshot: secretSnapshot("Auction Card"),
    ends_at: "2026-10-18T00:00:00Z",
    selection_deadline: "2026-10-21T00:00:00Z",
    status: "open",
    winning_bid_id: null,
    request_id: ID.request,
    settle_request_id: null,
    completed_at: null,
    created_at: "2026-10-17T00:00:00Z",
    updated_at: "2026-10-17T00:00:00Z",
  },
  phase: "bidding",
  bidCount: 1,
  viewerUserId: ID.viewer,
  myBid: null,
  seller: { id: ID.seller, twitchUsername: "seller", twitchDisplayName: "Seller", twitchProfileImageUrl: null },
  offeredStreamer: STREAMER,
};

function auctionRow(overrides: Record<string, unknown> = {}) {
  return { ...AUCTION_ROW, ...overrides };
}

const MY_BID = {
  id: ID.bid,
  auctionId: ID.auction,
  bidCardId: ID.wantedCard,
  bidStreamerId: ID.streamer,
  bidCard: secretSnapshot("Bid Card"),
  quantity: 1,
  isCrossChannel: false,
  status: "active",
  holds: true,
  settleable: true,
  createdAt: "2026-10-17T00:00:00Z",
};

const BID_DB_ROW = {
  bid: {
    id: ID.bid,
    auction_id: ID.auction,
    bidder_user_id: ID.bidder,
    bid_card_id: ID.wantedCard,
    bid_streamer_id: ID.streamer,
    quantity: 1,
    bid_card_snapshot: secretSnapshot("Bid Card"),
    is_cross_channel: false,
    status: "active",
    request_id: ID.request,
    created_at: "2026-10-17T00:00:00Z",
    updated_at: "2026-10-17T00:00:00Z",
  },
  holds: true,
  settleable: true,
  bidder: { id: ID.bidder, twitchUsername: "bidder", twitchDisplayName: "Bidder", twitchProfileImageUrl: null },
};

type Step = { rows?: unknown[]; error?: unknown };

/**
 * getDb double. `selects` is consumed in call order; the mask query is just
 * another select (it returns the visible card-id set).
 */
function prime(config: { selects?: Step[]; inserts?: Step[]; rpc?: Step[] } = {}) {
  let selectIndex = 0;
  let insertIndex = 0;
  let rpcIndex = 0;
  const selectCalls: Array<Record<string, unknown>> = [];
  const insertCalls: Array<{ values?: Record<string, unknown> }> = [];
  const resolve = (step: Step | undefined) =>
    step?.error ? Promise.reject(step.error) : Promise.resolve(step?.rows ?? []);

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const call: Record<string, unknown> = { fields };
      selectCalls.push(call);
      const step = (config.selects ?? [])[selectIndex++];
      const builder: any = {};
      for (const method of ["from", "leftJoin", "innerJoin", "orderBy", "limit", "offset"]) {
        builder[method] = vi.fn(() => builder);
      }
      builder.where = vi.fn((where: unknown) => {
        call.where = where;
        return builder;
      });
      builder.then = (onFulfilled: never, onRejected: never) => resolve(step).then(onFulfilled, onRejected);
      return builder;
    }),
    insert: vi.fn(() => {
      const step = (config.inserts ?? [])[insertIndex++];
      const call: { values?: Record<string, unknown> } = {};
      insertCalls.push(call);
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values;
          return builder;
        }),
        returning: vi.fn(() => resolve(step)),
      };
      return builder;
    }),
  };
  const sqlTag = vi.fn(() => resolve((config.rpc ?? [])[rpcIndex++]));
  vi.mocked(getDb).mockResolvedValue({ db, sql: sqlTag } as never);
  return { selectCalls, insertCalls, sqlTag };
}

const CREATE_INPUT = {
  twitchUserId: "viewer-1",
  offeredUserCardId: ID.offeredCopy,
  wantedCardId: ID.wantedCard,
  requestId: ID.request,
};

function checkRow() {
  return {
    userId: ID.offerer,
    replay: null,
    offeredUserCardId: ID.offeredCopy,
    offeredCardId: ID.offeredCard,
    offeredStreamerId: ID.streamer,
    offeredName: "Offered Name",
    offeredRarity: "legendary",
    offeredImageUrl: SECRET,
    offeredIsActive: true,
    wantedCardId: ID.wantedCard,
    wantedStreamerId: ID.streamer,
    wantedName: "Wanted Name",
    wantedRarity: "legendary",
    wantedImageUrl: SECRET,
    wantedWantable: true,
    offeredTradeEnabled: true,
    offeredCrossEnabled: false,
    wantedTradeEnabled: true,
    wantedCrossEnabled: false,
    offeredCopyListed: false,
    openOfferCount: 0,
  };
}

function precheckRow() {
  return {
    acceptorUserId: ID.viewer,
    status: "open",
    offererUserId: ID.offerer,
    acceptedByUserId: null,
    acceptedRequestId: null,
    offeredCardId: ID.offeredCard,
    wantedCardId: ID.wantedCard,
    offeredActive: true,
    wantedActive: true,
    wantedWantable: true,
    offeredVisible: true,
  };
}

const ACCEPT_RESULT = {
  success: true,
  tradeOfferId: ID.offer,
  receivedUserCardId: "90000000-0000-4000-8000-000000000001",
  givenUserCardId: "90000000-0000-4000-8000-000000000002",
  offeredCardSnapshot: secretSnapshot("Offered Name"),
  wantedCardSnapshot: secretSnapshot("Wanted Name"),
  completedAt: "2026-10-04T00:00:00.000Z",
  idempotentReplay: false,
};

function expectNoSecret(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(SECRET);
  expect(JSON.stringify(value)).not.toContain("secret.example");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("trade image leaks on name-only channels (#2070)", () => {
  it("listTradeOffers: masks both sides but keeps name and rarity", async () => {
    prime({ selects: [{ rows: [listRow()] }, { rows: [
          { cardId: ID.offeredCard, streamerId: ID.streamer, nameVisible: true, imageVisible: false },
          { cardId: ID.wantedCard, streamerId: ID.streamer, nameVisible: true, imageVisible: false },
        ] }] });
    const { listTradeOffers } = await import("@/lib/trade");
    const result = await listTradeOffers({
      streamerId: ID.streamer,
      scope: "in_channel",
      page: 1,
      twitchUserId: "viewer-1",
    });

    expectNoSecret(result);
    expect(result.offers[0].offeredCard).toMatchObject({ name: "Offered Name", rarity: "legendary" });
    expect(result.offers[0].wantedCard.imageUrl).toBeNull();
  });

  it("listTradeOffers: keeps the image when the viewer owns the card", async () => {
    prime({
      selects: [
        { rows: [listRow()] },
        { rows: [
          { cardId: ID.offeredCard, streamerId: ID.streamer, nameVisible: true, imageVisible: true },
          { cardId: ID.wantedCard, streamerId: ID.streamer, nameVisible: true, imageVisible: true },
        ] },
      ],
    });
    const { listTradeOffers } = await import("@/lib/trade");
    const result = await listTradeOffers({
      streamerId: ID.streamer,
      scope: "in_channel",
      page: 1,
      twitchUserId: "viewer-1",
    });

    expect(result.offers[0].offeredCard.imageUrl).toBe(SECRET);
    expect(result.offers[0].wantedCard.imageUrl).toBe(SECRET);
  });

  it("listMyTradeOffers: masks history rows, including completed ones", async () => {
    prime({
      selects: [
        {
          rows: [
            listRow({
              viewerUserId: ID.offerer,
              offer: { ...OFFER_ROW, status: "completed", accepted_by_user_id: ID.viewer },
            }),
          ],
        },
        { rows: [
          { cardId: ID.offeredCard, streamerId: ID.streamer, nameVisible: true, imageVisible: false },
          { cardId: ID.wantedCard, streamerId: ID.streamer, nameVisible: true, imageVisible: false },
        ] },
      ],
    });
    const { listMyTradeOffers } = await import("@/lib/trade");
    const result = await listMyTradeOffers("offerer");

    expectNoSecret(result);
    expect(result.offers[0].offeredCard.name).toBe("Offered Name");
    expect(result.offers[0].offeredCard.imageUrl).toBeNull();
  });

  it("createTradeOffer: the POST response carries no image", async () => {
    prime({
      selects: [
        { rows: [checkRow()] },
        { rows: [
          { cardId: ID.offeredCard, streamerId: ID.streamer, nameVisible: true, imageVisible: false },
          { cardId: ID.wantedCard, streamerId: ID.streamer, nameVisible: true, imageVisible: false },
        ] },
      ],
      inserts: [{ rows: [{ ...OFFER_ROW, offered_card_snapshot: secretSnapshot("Offered Name"), wanted_card_snapshot: secretSnapshot("Wanted Name") }] }],
    });
    const { createTradeOffer } = await import("@/lib/trade");
    const result = await createTradeOffer(CREATE_INPUT);

    expect(result.kind).toBe("ok");
    expectNoSecret(result);
    if (result.kind === "ok") {
      expect(result.offer.offered_card_snapshot).toMatchObject({ name: "Offered Name", rarity: "legendary" });
      expect((result.offer.wanted_card_snapshot as { imageUrl: string | null }).imageUrl).toBeNull();
    }
  });

  it("createTradeOffer: the stored snapshot keeps the full image (write is not masked)", async () => {
    const pg = prime({
      selects: [{ rows: [checkRow()] }, { rows: [] }],
      inserts: [{ rows: [{ ...OFFER_ROW }] }],
    });
    const { createTradeOffer } = await import("@/lib/trade");
    await createTradeOffer(CREATE_INPUT);

    // Masking happens on the returned row only: the JSONB written to
    // trade_offers must stay complete so a later owner still sees the image.
    expect(pg.insertCalls).toHaveLength(1);
    expect(pg.insertCalls[0].values?.offered_card_snapshot).toMatchObject({ imageUrl: SECRET });
    expect(pg.insertCalls[0].values?.wanted_card_snapshot).toMatchObject({ imageUrl: SECRET });
  });

  it("acceptTradeOffer: the response snapshots are masked", async () => {
    prime({
      selects: [{ rows: [precheckRow()] }, { rows: [
        { cardId: ID.offeredCard, streamerId: ID.streamer, nameVisible: true, imageVisible: false },
        { cardId: ID.wantedCard, streamerId: ID.streamer, nameVisible: true, imageVisible: false },
      ] }],
      rpc: [{ rows: [{ result: ACCEPT_RESULT }] }],
    });
    const { acceptTradeOffer } = await import("@/lib/trade");
    const result = await acceptTradeOffer({
      twitchUserId: "viewer-1",
      tradeOfferId: ID.offer,
      requestId: ID.request,
    });

    expectNoSecret(result);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.offeredCardSnapshot).toMatchObject({ name: "Offered Name", rarity: "legendary" });
      expect((result.wantedCardSnapshot as { imageUrl: string | null }).imageUrl).toBeNull();
    }
  });

  it("listWantableCards: drops the image unless the viewer owns it or details are public", async () => {
    prime({
      selects: [{
        rows: [
          { cardId: ID.wantedCard, name: "Wanted Name", rarity: "legendary", rarityOrder: 2, imageUrl: SECRET, isOwned: false, nameVisible: true, imageVisible: false },
          { cardId: ID.offeredCard, name: "Owned", rarity: "rare", rarityOrder: 1, imageUrl: SECRET, isOwned: true, nameVisible: true, imageVisible: true },
        ],
      }],
    });
    const { listWantableCards } = await import("@/lib/trade");
    const result = await listWantableCards("viewer-1", ID.streamer);

    // 並び（rarity_order 昇順）は JS 側で決まり、モックの行順には従わない。
    // マスクの検証は行順に依存させず cardId で引く。
    const wanted = result.find((card) => card.cardId === ID.wantedCard);
    const owned = result.find((card) => card.cardId === ID.offeredCard);
    expect(wanted?.imageUrl).toBeNull();
    expect(wanted?.name).toBe("Wanted Name");
    expect(owned?.imageUrl).toBe(SECRET);
    // モックの行順は [wanted(rarityOrder 2), owned(rarityOrder 1)]。
    // rarity_order 昇順に並び替わることを明示する。
    expect(result.map((card) => card.cardId)).toEqual([ID.offeredCard, ID.wantedCard]);
  });

  it("listTradeAuctions: masks the offered snapshot of a name-only auction", async () => {
    prime({ selects: [{ rows: [auctionRow()] }, { rows: [] }] });
    const { listTradeAuctions } = await import("@/lib/trade-auction");
    const result = await listTradeAuctions({ streamerId: ID.streamer, scope: "in_channel", page: 1, twitchUserId: "viewer-1" });

    expectNoSecret(result);
    // 行ルール変更後は、名前非公開のオークション行も #N だけで表示され得る。
    // 共有マスクは名前も落とす（UI の #N 表示は次タスク）。
    expect(result.auctions[0].offeredCard).toMatchObject({ name: "", rarity: "legendary" });
    expect(result.auctions[0].offeredCard.imageUrl).toBeNull();
  });

  it("getTradeAuction (non-participant): masks the offered snapshot", async () => {
    prime({
      selects: [{ rows: [auctionRow({ viewerUserId: null, myBid: null })] }, { rows: [] }],
    });
    const { getTradeAuction } = await import("@/lib/trade-auction");
    const result = await getTradeAuction({ auctionId: ID.auction });

    expectNoSecret(result);
    expect(result?.auction.offeredCard.imageUrl).toBeNull();
  });

  it("getTradeAuction (seller): masks the bid list's card snapshot", async () => {
    prime({
      selects: [
        { rows: [auctionRow({ viewerUserId: ID.seller })] },
        {
          rows: [{
            ...BID_DB_ROW,
            bid: { ...BID_DB_ROW.bid, bid_card_snapshot: { name: "Bid Card", rarity: "legendary", imageUrl: BID_SECRET } },
          }],
        },
        { rows: [
          { cardId: ID.offeredCard, streamerId: ID.streamer, nameVisible: true, imageVisible: true },
          { cardId: ID.wantedCard, streamerId: ID.streamer, nameVisible: true, imageVisible: false },
        ] },
      ],
    });
    const { getTradeAuction } = await import("@/lib/trade-auction");
    const result = await getTradeAuction({ auctionId: ID.auction, twitchUserId: "seller" });

    // The seller owns the offered card, so that image legitimately stays; the
    // bid card (which the seller may only see the name of) is masked.
    expect(JSON.stringify(result)).not.toContain(BID_SECRET);
    expect(result?.auction.offeredCard.imageUrl).toBe(SECRET);
    expect(result?.bids?.[0].bidCard).toMatchObject({ name: "Bid Card", rarity: "legendary", imageUrl: null });
  });

  it("getTradeAuction (bidder): masks myBid's card snapshot", async () => {
    prime({
      selects: [
        { rows: [auctionRow({ viewerUserId: ID.viewer, myBid: MY_BID })] },
        { rows: [] },
      ],
    });
    const { getTradeAuction } = await import("@/lib/trade-auction");
    const result = await getTradeAuction({ auctionId: ID.auction, twitchUserId: "viewer-1" });

    expectNoSecret(result);
    expect(result?.auction.myBid?.bidCard.imageUrl).toBeNull();
  });

  it("listMyTradeAuctions (bidding): masks myBid's card snapshot", async () => {
    prime({
      selects: [
        { rows: [auctionRow({ viewerUserId: ID.viewer, myBid: MY_BID })] },
        { rows: [] },
      ],
    });
    const { listMyTradeAuctions } = await import("@/lib/trade-auction");
    const result = await listMyTradeAuctions("viewer-1", { role: "bidding" });

    expectNoSecret(result);
    expect(result.auctions[0].myBid?.bidCard.imageUrl).toBeNull();
  });

  it("placeTradeAuctionBid: the response never contains card images", async () => {
    prime({
      selects: [{
        rows: [{
          bidderUserId: ID.viewer,
          sellerUserId: ID.seller,
          isReplay: false,
          offeredVisible: true,
          bidCardVisibleToBidder: true,
          bidCardVisibleToSeller: true,
        }],
      }],
      rpc: [{
        rows: [{
          result: {
            success: true,
            bid: { id: ID.bid, auction_id: ID.auction, bid_card_id: ID.wantedCard, quantity: 1, status: "active" },
            replacedBidId: null,
            idempotentReplay: false,
          },
        }],
      }],
    });
    const { placeTradeAuctionBid } = await import("@/lib/trade-auction");
    const result = await placeTradeAuctionBid({
      twitchUserId: "viewer-1",
      auctionId: ID.auction,
      bidCardId: ID.wantedCard,
      quantity: 1,
      requestId: ID.request,
    });

    expect(result.kind).toBe("ok");
    expectNoSecret(result);
  });
});
