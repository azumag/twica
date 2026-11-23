import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2080: shared create-form data loader.
 *
 * The old /trade/[streamerId]/new page owned this composition. It now lives in
 * src/lib/trade-create-flow.ts so the new /trade/new page and the legacy
 * redirect cannot drift: the wanted channel's reveal flags decide the notice
 * props, and an auction (no wanted channel) must not read a catalogue at all.
 */
const mocks = vi.hoisted(() => ({
  listTradeableOwnedCopies: vi.fn(),
  listWantableCards: vi.fn(),
  getTradeBoardStreamer: vi.fn(),
  getDb: vi.fn(),
  loadAllowedWantedByOffered: vi.fn(),
}));

vi.mock("@/lib/trade", () => ({
  listTradeableOwnedCopies: mocks.listTradeableOwnedCopies,
  listWantableCards: mocks.listWantableCards,
  getTradeBoardStreamer: mocks.getTradeBoardStreamer,
}));
vi.mock("@/lib/db/client", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/trade-wanted-restrictions", () => ({
  loadAllowedWantedByOffered: mocks.loadAllowedWantedByOffered,
}));

import {
  isTradeAuctionSchemaAvailable,
  listViewerTradeCollections,
  loadTradeCreateFormData,
} from "@/lib/trade-create-flow";

const GIVE = "11111111-1111-4111-8111-111111111111";
const WANT = "22222222-2222-4222-8222-222222222222";

const COPIED = {
  userCardId: "uc-1",
  cardId: "card-1",
  name: "Card One",
  rarity: "common",
  imageUrl: null,
  obtainedAt: null,
  isListed: false,
  ownedCount: 1,
};
const WANTABLE = {
  cardId: "card-2",
  name: "Visible Card",
  rarity: "rare",
  imageUrl: null,
  collectionNumber: null,
  isOwned: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listTradeableOwnedCopies.mockResolvedValue([COPIED]);
  mocks.listWantableCards.mockResolvedValue([WANTABLE]);
  mocks.loadAllowedWantedByOffered.mockResolvedValue({});
  mocks.getTradeBoardStreamer.mockResolvedValue({
    // 行としても名前としても未所持カードを公開している状態（画像だけ非公開）。
    revealsUnownedCards: true,
    revealsUnownedCardNames: true,
    revealsUnownedCardImages: false,
  });
});

describe("loadTradeCreateFormData (#2080)", () => {
  it("loads the give copies and the wanted catalogue with the wanted channel's reveal flags", async () => {
    const data = await loadTradeCreateFormData({
      viewerId: "viewer-1",
      giveStreamerId: GIVE,
      wantStreamerId: WANT,
    });

    expect(mocks.listTradeableOwnedCopies).toHaveBeenCalledWith("viewer-1", GIVE);
    expect(mocks.listWantableCards).toHaveBeenCalledWith("viewer-1", WANT);
    expect(mocks.getTradeBoardStreamer).toHaveBeenCalledWith(WANT);
    expect(data).toEqual({
      ownedCopies: [COPIED],
      wantableCards: [WANTABLE],
      allowedWantedByOfferedCardId: {},
      // 行の可視性と名前の可視性は独立したフラグとして渡す（C4a）。
      wantableRevealsUnownedCards: true,
      wantableRevealsUnownedNames: true,
    });
  });

  it("forwards the row and name flags independently (names hidden, rows visible)", async () => {
    // 行は見える（未所持カードを #N で選べる）が名前は非公開、という C3a 以降の
    // 典型状態。2つの案内を取り違えないよう、値がそのまま分かれて届くことを固定する。
    mocks.getTradeBoardStreamer.mockResolvedValue({
      revealsUnownedCards: true,
      revealsUnownedCardNames: false,
      revealsUnownedCardImages: false,
    });
    const data = await loadTradeCreateFormData({
      viewerId: "viewer-1",
      giveStreamerId: GIVE,
      wantStreamerId: WANT,
    });
    expect(data.wantableRevealsUnownedCards).toBe(true);
    expect(data.wantableRevealsUnownedNames).toBe(false);
  });

  it("does not read a wanted catalogue for an auction (no wanted channel)", async () => {
    const data = await loadTradeCreateFormData({
      viewerId: "viewer-1",
      giveStreamerId: GIVE,
      wantStreamerId: null,
    });

    expect(mocks.listTradeableOwnedCopies).toHaveBeenCalledWith("viewer-1", GIVE);
    expect(mocks.listWantableCards).not.toHaveBeenCalled();
    expect(mocks.getTradeBoardStreamer).not.toHaveBeenCalled();
    // An auction has no wanted card, so there is no restriction to read.
    expect(mocks.loadAllowedWantedByOffered).not.toHaveBeenCalled();
    expect(data).toEqual({
      ownedCopies: [COPIED],
      wantableCards: [],
      allowedWantedByOfferedCardId: {},
      // Deny-by-default: the auction branch renders no wanted-catalogue notice.
      wantableRevealsUnownedCards: false,
      wantableRevealsUnownedNames: false,
    });
  });

  it("passes the exchange-target restriction map, built from the owned copies and ONLY the visible wanted cards", async () => {
    // The map is serialized to the client: the loader must intersect with the
    // already-visibility-filtered catalogue (selectable ids = wantableCards).
    mocks.listTradeableOwnedCopies.mockResolvedValue([COPIED, { ...COPIED, userCardId: "uc-2" }]);
    mocks.loadAllowedWantedByOffered.mockResolvedValue({ "card-1": ["card-2"] });
    const data = await loadTradeCreateFormData({
      viewerId: "viewer-1",
      giveStreamerId: GIVE,
      wantStreamerId: WANT,
    });
    expect(mocks.loadAllowedWantedByOffered).toHaveBeenCalledTimes(1);
    const [where, selectable] = mocks.loadAllowedWantedByOffered.mock.calls[0];
    // De-duplicated offered card ids (two copies of card-1).
    expect(where).toEqual({ offeredCardIds: ["card-1"] });
    expect([...selectable]).toEqual(["card-2"]);
    expect(data.allowedWantedByOfferedCardId).toEqual({ "card-1": ["card-2"] });
  });

  it("does not read the restriction map when there is nothing to choose from", async () => {
    mocks.listWantableCards.mockResolvedValue([]);
    const data = await loadTradeCreateFormData({
      viewerId: "viewer-1",
      giveStreamerId: GIVE,
      wantStreamerId: WANT,
    });
    expect(mocks.loadAllowedWantedByOffered).not.toHaveBeenCalled();
    expect(data.allowedWantedByOfferedCardId).toEqual({});
  });

  it("fails closed when the wanted channel disappeared between the gate and the read", async () => {
    mocks.getTradeBoardStreamer.mockResolvedValue(null);
    const data = await loadTradeCreateFormData({
      viewerId: "viewer-1",
      giveStreamerId: GIVE,
      wantStreamerId: WANT,
    });
    expect(data.wantableRevealsUnownedCards).toBe(false);
    expect(data.wantableRevealsUnownedNames).toBe(false);
  });
});

describe("isTradeAuctionSchemaAvailable (#2080 deploy window)", () => {
  it("is true only when the catalog lookup finds the auction table", async () => {
    // Same raw-SQL shape as src/lib/trade-auction.ts: getDb()'s postgres.js
    // client (`sql`) is the tagged template, not Drizzle's db.execute (#2080
    // review). The old shape could silently read `undefined` on a driver whose
    // result is not an array.
    const query = vi.fn().mockResolvedValue([{ available: true }]);
    mocks.getDb.mockResolvedValue({ db: {}, sql: query });

    await expect(isTradeAuctionSchemaAvailable()).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    // the probe must be the catalog-only lookup, never a table scan
    expect(String(query.mock.calls[0][0])).toContain(
      "to_regclass('public.trade_auctions') IS NOT NULL AS available",
    );
  });

  it.each([
    ["the table is missing", [{ available: false }]],
    ["the result is empty", []],
  ])("fails closed when %s", async (_name, rows) => {
    mocks.getDb.mockResolvedValue({
      db: {},
      sql: vi.fn().mockResolvedValue(rows),
    });
    await expect(isTradeAuctionSchemaAvailable()).resolves.toBe(false);
  });

  it("fails closed when the read throws instead of breaking the page", async () => {
    mocks.getDb.mockResolvedValue({
      db: {},
      sql: vi.fn().mockRejectedValue(new Error("db down")),
    });
    await expect(isTradeAuctionSchemaAvailable()).resolves.toBe(false);
  });
});

describe("listViewerTradeCollections (#2080)", () => {
  function primeCollections(rows: unknown[]) {
    const builder: Record<string, unknown> = {};
    builder.from = () => builder;
    builder.where = () => builder;
    builder.orderBy = () => builder;
    builder.then = (
      onFulfilled: (value: unknown) => unknown,
      onRejected: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected);
    const select = vi.fn(() => builder);
    mocks.getDb.mockResolvedValue({ db: { select }, sql: {} });
    return select;
  }

  it("reads every owned collection in one statement and maps the trade flags", async () => {
    const select = primeCollections([
      {
        id: GIVE,
        twitchDisplayName: "Alpha",
        twitchProfileImageUrl: null,
        tradeEnabled: true,
        crossChannelTradeEnabled: false,
      },
      {
        id: WANT,
        twitchDisplayName: "Beta",
        twitchProfileImageUrl: "https://img.example/beta.png",
        // Columns can come back NULL from a partially applied schema.
        tradeEnabled: null,
        crossChannelTradeEnabled: null,
      },
    ]);

    const result = await listViewerTradeCollections("viewer-1");

    // One statement for the whole list, never one per collection.
    expect(select).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        id: GIVE,
        twitchDisplayName: "Alpha",
        twitchProfileImageUrl: null,
        tradeEnabled: true,
        crossChannelTradeEnabled: false,
      },
      {
        id: WANT,
        twitchDisplayName: "Beta",
        twitchProfileImageUrl: "https://img.example/beta.png",
        tradeEnabled: false,
        crossChannelTradeEnabled: false,
      },
    ]);
  });
});
