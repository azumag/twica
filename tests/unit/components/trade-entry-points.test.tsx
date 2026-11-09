import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Collection from "@/components/Collection";
import StreamerCollection from "@/components/StreamerCollection";
import type { Streamer } from "@/types/database";

/**
 * Trade entry points (#726/#727 §6.2/§6.6):
 *  - /collection/[streamerId] shows "Trade" only when the channel allows trading
 *  - /dashboard/collection links to /trade/mine
 * Both are additionally gated by CARD_TRADE_UI_VISIBLE (#715, main #1803/#1805):
 * while it is false (the shipped value) no entry point is rendered at all.
 * The flag is a module constant, so the test swaps it through a getter backed
 * by a hoisted mutable object to exercise both the visible and hidden states.
 */
const flags = vi.hoisted(() => ({ visible: true }));
vi.mock("@/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/constants")>();
  return {
    ...actual,
    get CARD_TRADE_UI_VISIBLE() {
      return flags.visible;
    },
  };
});
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/components/Stats", () => ({ default: () => null }));
vi.mock("@/components/CollectionProgress", () => ({ default: () => null }));
vi.mock("@/components/SortedCardGrid", () => ({ default: () => null }));
vi.mock("@/components/CollectionPackFilter", () => ({ default: () => null }));

const streamer = {
  id: "streamer-1",
  twitch_display_name: "TestStreamer",
  twitch_profile_image_url: null,
} as unknown as Streamer;

const baseProps = {
  streamer,
  cards: [],
  stats: { total: 0, unique: 0, legendary: 0, epic: 0, rare: 0, common: 0 },
  progress: { owned: 0, total: 0 },
  visibleCardTypes: 0,
};

describe("trade entry points (CARD_TRADE_UI_VISIBLE=true)", () => {
  beforeEach(() => {
    flags.visible = true;
  });

  it("collection page shows the Trade button when trade is enabled", async () => {
    render(await StreamerCollection({ ...baseProps, tradeEnabled: true }));
    expect(screen.getByRole("link", { name: "collectionTradeButton" })).toHaveAttribute(
      "href",
      "/trade/streamer-1",
    );
  });

  it("collection page hides the Trade button by default (trade disabled / unknown)", async () => {
    render(await StreamerCollection(baseProps));
    expect(screen.queryByRole("link", { name: "collectionTradeButton" })).toBeNull();
  });

  it("my collection header links to /trade/mine", async () => {
    render(await Collection({ cardsByStreamer: {} }));
    expect(screen.getByRole("link", { name: "myTradesLink" })).toHaveAttribute("href", "/trade/mine");
  });
});

describe("trade entry points (CARD_TRADE_UI_VISIBLE=false, #715)", () => {
  beforeEach(() => {
    flags.visible = false;
  });

  it("collection page hides the Trade button even when trade is enabled", async () => {
    render(await StreamerCollection({ ...baseProps, tradeEnabled: true }));
    expect(screen.queryByRole("link", { name: "collectionTradeButton" })).toBeNull();
  });

  it("my collection header hides the /trade/mine link", async () => {
    render(await Collection({ cardsByStreamer: {} }));
    expect(screen.queryByRole("link", { name: "myTradesLink" })).toBeNull();
  });
});
