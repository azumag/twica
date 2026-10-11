import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Collection from "@/components/Collection";
import StreamerCollection from "@/components/StreamerCollection";
import type { Streamer } from "@/types/database";

/**
 * Trade entry points (#726/#727 §6.2/§6.6):
 *  - /collection/[streamerId] shows "Trade" only when the channel allows trading
 *  - /dashboard/collection always links to /trade/mine
 */
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

describe("trade entry points", () => {
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

  it("my collection header always links to /trade/mine", async () => {
    render(await Collection({ cardsByStreamer: {} }));
    expect(screen.getByRole("link", { name: "myTradesLink" })).toHaveAttribute("href", "/trade/mine");
  });
});
