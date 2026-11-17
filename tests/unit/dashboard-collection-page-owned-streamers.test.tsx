import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * #2079: /dashboard/collection と /trade が同じ「持っているコレクション」を
 * 使うことを、ページの props で固定する。所持集合の正本は
 * getCollectedStreamerIds() で、ページは getUserCards() のグループをその集合で
 * 絞る。取得に失敗したときだけ getUserCards 由来の集合へ縮退する。
 */
const mocks = vi.hoisted(() => ({
  getCollectedStreamerIds: vi.fn(),
}));

const STREAMER_A = {
  id: "streamer-a",
  twitch_display_name: "A",
  twitch_username: "a",
  twitch_profile_image_url: null,
};
const STREAMER_B = {
  id: "streamer-b",
  twitch_display_name: "B",
  twitch_username: "b",
  twitch_profile_image_url: null,
};

function ownedCard(id: string, streamer: typeof STREAMER_A) {
  return {
    id,
    streamer_id: streamer.id,
    name: id,
    description: null,
    image_url: null,
    image_padding_color: null,
    rarity: "common",
    card_number: 1,
    max_issuance_count: null,
    issued_count: 0,
    collection_name: null,
    drop_rate: 1,
    intra_rarity_weight: 1,
    is_active: true,
    hp: 0,
    atk: 0,
    def: 0,
    spd: 0,
    skill_type: "attack",
    skill_name: "",
    skill_power: 0,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    streamer,
    count: 1,
  };
}

vi.mock("@/lib/session", () => ({ getSession: async () => ({ twitchUserId: "viewer" }) }));
vi.mock("@/lib/dashboard-data", () => ({
  getUserCards: async () => [
    ownedCard("card-a", STREAMER_A),
    ownedCard("card-b", STREAMER_B),
  ],
  getHiddenCollectionStreamerIds: async () => new Set<string>(),
  getLastObtainedAtByStreamer: async () => new Map([
    ["streamer-a", "2026-10-01T00:00:00.000Z"],
    ["streamer-b", "2026-10-02T00:00:00.000Z"],
  ]),
  getActiveCardCountsForCollectedStreamers: async () => new Map([
    ["streamer-a", { totalActive: 1, activeCardIds: new Set(["card-a"]) }],
    ["streamer-b", { totalActive: 1, activeCardIds: new Set(["card-b"]) }],
  ]),
}));
vi.mock("@/lib/collected-streamers", () => ({
  getCollectedStreamerIds: mocks.getCollectedStreamerIds,
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/Collection", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="collection" data-props={JSON.stringify(props)} />
  ),
}));

import CollectionPage from "@/app/dashboard/collection/page";

function props() {
  return JSON.parse(screen.getByTestId("collection").getAttribute("data-props")!) as {
    cardsByStreamer: Record<string, unknown>;
    orders: Record<string, Record<string, string[]>>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/dashboard/collection owned streamers (#2079)", () => {
  it("filters the grouped cards by the same getCollectedStreamerIds used by /trade", async () => {
    mocks.getCollectedStreamerIds.mockResolvedValue(new Set(["streamer-a"]));
    render(await CollectionPage());

    expect(mocks.getCollectedStreamerIds).toHaveBeenCalledWith("viewer");
    expect(Object.keys(props().cardsByStreamer)).toEqual(["streamer-a"]);
    expect(props().orders.recent.desc).toEqual(["streamer-a"]);
  });

  it("falls back to the cards-derived set (and logs) when the ownership lookup fails", async () => {
    mocks.getCollectedStreamerIds.mockRejectedValue(new Error("db down"));
    render(await CollectionPage());

    expect(Object.keys(props().cardsByStreamer).sort()).toEqual(["streamer-a", "streamer-b"]);
  });
});
