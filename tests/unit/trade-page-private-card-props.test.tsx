import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { getTableName } from "drizzle-orm";

import { getDb } from "@/lib/db/client";

/**
 * #2070: RSC props の漏れ検出。
 *
 * 名前だけ公開（show_unowned_cards=true, details=false,
 * trade_unowned_card_names_visible=true）の配信者では、未所持カードの名前と
 * レアリティは見せてよいが画像は見せない。RSC props はブラウザへそのまま
 * シリアライズされるので、ページが service の戻り値をそのまま渡す経路でも
 * 秘密の URL が混ざらないことを、ページ関数を直接 await して確かめる。
 *
 * collection-page-private-card-props.test.tsx と同じ考え方で、データ層だけを
 * DB モックに差し替え、ページとサービス（実物）を通す。マスクは service の
 * SELECT 結果（imageVisible / 可視カード ID 集合）で決まるため、ここでは
 * 「画像が見えない」応答を返して props を検査する。
 */
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getMessages: async () => ({}),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/TradeCreateForm", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="create-props" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("@/components/TradeAuctionDetail", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="auction-detail-props" data-props={JSON.stringify(props)} />
  ),
}));
vi.mock("@/components/MyTrades", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="my-trades-props" data-props={JSON.stringify(props)} />
  ),
}));

const SECRET = "https://secret.example/unowned-card.png";
const STREAMER_ID = "11111111-1111-4111-8111-111111111111";
const AUCTION_ID = "22222222-2222-4222-8222-222222222222";
const CARD_ID = "33333333-3333-4333-8333-333333333333";
const VIEWER_ID = "44444444-4444-4444-8444-444444444444";

const STREAMER_ROW = {
  id: STREAMER_ID,
  twitchUsername: "chan",
  twitchDisplayName: "Chan",
  twitchProfileImageUrl: null,
  showUnownedCards: true,
  showUnownedCardDetails: false,
  tradeUnownedCardNamesVisible: true,
  tradeEnabled: true,
  crossChannelTradeEnabled: true,
};

const WANTABLE_ROW = {
  cardId: CARD_ID,
  name: "Secret Card",
  rarity: "legendary",
  imageUrl: SECRET,
  isOwned: true,
  // details=false, name-only=true: the name is visible but the image is not.
  imageVisible: false,
};

const LIST_ROW = {
  offer: {
    id: "55555555-5555-4555-8555-555555555555",
    offerer_user_id: VIEWER_ID,
    offered_user_card_id: "66666666-6666-4666-8666-666666666666",
    offered_card_id: "77777777-7777-4777-8777-777777777777",
    offered_streamer_id: STREAMER_ID,
    wanted_card_id: CARD_ID,
    wanted_streamer_id: STREAMER_ID,
    offered_card_snapshot: { name: "Offered Name", rarity: "rare", imageUrl: SECRET },
    wanted_card_snapshot: { name: "Secret Card", rarity: "legendary", imageUrl: SECRET },
    wanted_quantity: 1,
    is_cross_channel: false,
    status: "open",
    accepted_by_user_id: null,
    accepted_user_card_id: null,
    completed_at: null,
    request_id: "88888888-8888-4888-8888-888888888888",
    accepted_request_id: null,
    created_at: "2026-10-04T00:00:00.000Z",
    updated_at: "2026-10-04T00:00:00.000Z",
  },
  viewerUserId: VIEWER_ID,
  offeredStreamer: {
    id: STREAMER_ID,
    twitchUsername: "chan",
    twitchDisplayName: "Chan",
    twitchProfileImageUrl: null,
  },
  wantedStreamer: {
    id: STREAMER_ID,
    twitchUsername: "chan",
    twitchDisplayName: "Chan",
    twitchProfileImageUrl: null,
  },
  offerer: {
    id: VIEWER_ID,
    twitchUsername: "viewer",
    twitchDisplayName: "Viewer",
    twitchProfileImageUrl: null,
  },
  acceptedBy: { id: null, twitchUsername: null, twitchDisplayName: null, twitchProfileImageUrl: null },
  acceptState: null,
  tradeableState: false,
};

/**
 * getDb double keyed by the FROM table. Several service reads run in
 * Promise.all (owned copies + wantable cards), so a call-order queue would be
 * racy; the table is unambiguous instead. The image mask query also starts
 * from `cards`, but it is only used by the /trade hub prefetch, which does not
 * read cards anywhere else.
 */
function primeDb(rows: { streamers?: unknown[]; cards?: unknown[]; user_cards?: unknown[]; trade_offers?: unknown[] }) {
  const calls: Array<{ fields: Record<string, unknown>; table: string | null }> = [];
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const call = { fields, table: null as string | null };
      calls.push(call);
      const builder: any = {};
      builder.from = vi.fn((table: unknown) => {
        call.table = getTableName(table as never);
        return builder;
      });
      for (const method of ["innerJoin", "leftJoin", "orderBy", "limit", "offset"]) {
        builder[method] = vi.fn(() => builder);
      }
      builder.where = vi.fn(() => builder);
      builder.then = (onFulfilled: never, onRejected: never) =>
        Promise.resolve(rows[(call.table ?? "") as keyof typeof rows] ?? []).then(onFulfilled, onRejected);
      return builder;
    }),
  };
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as never);
  return { calls };
}

function props(testId: string) {
  return JSON.parse(screen.getByTestId(testId).getAttribute("data-props")!) as Record<string, unknown>;
}

function expectNoSecret(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(SECRET);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ twitchUserId: "viewer-1" });
});

describe("trade RSC props on a name-only channel (#2070)", () => {
  it("the create page never serializes an unowned card image", async () => {
    primeDb({ streamers: [STREAMER_ROW], cards: [WANTABLE_ROW], user_cards: [] });
    const { default: TradeCreatePage } = await import("@/app/trade/[streamerId]/new/page");

    render(await TradeCreatePage({
      params: Promise.resolve({ streamerId: STREAMER_ID }),
      searchParams: Promise.resolve({}),
    }));

    const passed = props("create-props");
    expectNoSecret(passed);
    expect(passed.wantableCards).toEqual([
      { cardId: CARD_ID, name: "Secret Card", rarity: "legendary", imageUrl: null, isOwned: true },
    ]);
    // The channel reveals names, so the form must not claim it hides them.
    expect(passed.wantableRevealsUnowned).toBe(true);
  });

  it("the auction detail page never serializes a bid candidate image", async () => {
    primeDb({ streamers: [STREAMER_ROW], cards: [WANTABLE_ROW], user_cards: [] });
    const { default: TradeAuctionDetailPage } = await import(
      "@/app/trade/[streamerId]/auctions/[auctionId]/page"
    );

    render(await TradeAuctionDetailPage({
      params: Promise.resolve({ streamerId: STREAMER_ID, auctionId: AUCTION_ID }),
      searchParams: Promise.resolve({}),
    }));

    const passed = props("auction-detail-props");
    expectNoSecret(passed);
    expect(passed.bidCards).toEqual([
      { cardId: CARD_ID, name: "Secret Card", rarity: "legendary", imageUrl: null, freeCount: 0 },
    ]);
  });

  it("the /trade hub prefetch never serializes an image of an unowned wanted card", async () => {
    primeDb({ trade_offers: [LIST_ROW], cards: [] });
    const { default: TradeHubPage } = await import("@/app/trade/page");

    render(await TradeHubPage());

    const passed = props("my-trades-props");
    expectNoSecret(passed);
    const initialOpen = passed.initialOpen as { offers: Array<Record<string, unknown>> };
    expect(initialOpen.offers).toHaveLength(1);
    expect(JSON.stringify(initialOpen.offers[0])).toContain("Secret Card");
    expect(
      (initialOpen.offers[0].wantedCard as { imageUrl: string | null }).imageUrl,
    ).toBeNull();
  });
});
