// Issue #393再設計: カードパックは自由入力ではなく、事前登録済み
// (streamers.card_pack_names)であることを要求するmembership検証のテスト。
// #269のプレミアムゲートは廃止され(パック管理モーダルでの追加時のみに移設)、
// cards POST/PUTではプラン判定を一切行わない。

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/cards/route";
import { PUT } from "@/app/api/cards/[id]/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { getStorageUsage } from "@/lib/storage-usage";
import { createMockQueryBuilder } from "../../utils/supabase-mock";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/storage-usage");
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockGetStorageUsage = vi.mocked(getStorageUsage);

const SESSION = {
  twitchUserId: "user1",
  twitchUsername: "streamer",
  twitchDisplayName: "Streamer",
  twitchProfileImageUrl: "",
  broadcasterType: "affiliate" as const,
  expiresAt: Date.now() + 60_000,
  version: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(SESSION);
  mockCanUseStreamerFeatures.mockReturnValue(true);
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: Date.now() + 60_000,
  });
  mockValidateCSRFToken.mockResolvedValue({ valid: true });
  mockGetStorageUsage.mockResolvedValue({ planOverLimit: false } as Awaited<ReturnType<typeof getStorageUsage>>);
});

describe("POST /api/cards card-pack membership validation (Issue #393再設計)", () => {
  it("rejects an unregistered pack name (400)", async () => {
    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "streamer1", rarity_weights: null, card_pack_names: ["characters"] },
      error: null,
    });
    const cardsQuery = createMockQueryBuilder();
    const fromMock = vi.fn((table: string) => (table === "streamers" ? streamerQuery : cardsQuery));

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        streamerId: "streamer1",
        name: "Sword",
        description: "",
        imageUrl: "https://example.com/a.png",
        rarity: "common",
        dropRate: 0.5,
        collectionName: "weapons",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(cardsQuery.insert).not.toHaveBeenCalled();
  });

  it("persists a registered pack name (200)", async () => {
    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "streamer1", rarity_weights: null, card_pack_names: ["weapons"] },
      error: null,
    });
    const cardsQuery = createMockQueryBuilder();
    (cardsQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "card1", streamer_id: "streamer1", collection_name: "weapons" },
      error: null,
    });
    const fromMock = vi.fn((table: string) => (table === "streamers" ? streamerQuery : cardsQuery));

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        streamerId: "streamer1",
        name: "Sword",
        description: "",
        imageUrl: "https://example.com/a.png",
        rarity: "common",
        dropRate: 0.5,
        collectionName: "weapons",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(cardsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: "weapons" })
    );
  });

  // Issue #555: DEFAULT_PACK_SENTINEL ("default pack only") is meaningful ONLY
  // as a gacha/reward FILTER value ("draw from unclassified cards"); a card's
  // own default-pack membership is expressed by collection_name = NULL, never
  // by this sentinel string. The sentinel is reserved (isReservedCollectionName)
  // so it can never be registered in card_pack_names, meaning the existing
  // membership check rejects it automatically — this test fixes that behavior.
  it("rejects DEFAULT_PACK_SENTINEL as a card's collectionName (400) — cards use null, not the sentinel", async () => {
    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "streamer1", rarity_weights: null, card_pack_names: ["weapons"] },
      error: null,
    });
    const cardsQuery = createMockQueryBuilder();
    const fromMock = vi.fn((table: string) => (table === "streamers" ? streamerQuery : cardsQuery));

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        streamerId: "streamer1",
        name: "Sword",
        description: "",
        imageUrl: "https://example.com/a.png",
        rarity: "common",
        dropRate: 0.5,
        collectionName: DEFAULT_PACK_SENTINEL,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(cardsQuery.insert).not.toHaveBeenCalled();
  });

  it("allows a null (unclassified) pack with no membership check needed", async () => {
    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "streamer1", rarity_weights: null, card_pack_names: [] },
      error: null,
    });
    const cardsQuery = createMockQueryBuilder();
    (cardsQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "card1", streamer_id: "streamer1", collection_name: null },
      error: null,
    });
    const fromMock = vi.fn((table: string) => (table === "streamers" ? streamerQuery : cardsQuery));

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        streamerId: "streamer1",
        name: "Sword",
        description: "",
        imageUrl: "https://example.com/a.png",
        rarity: "common",
        dropRate: 0.5,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
  });

  it("creates the card but drops the pack assignment when card_pack_names is not deployed yet (deploy window)", async () => {
    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { code: "42703", message: "column streamers.card_pack_names does not exist" },
    });
    const retryStreamerQuery = createMockQueryBuilder();
    (retryStreamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "streamer1", rarity_weights: null },
      error: null,
    });
    const cardsQuery = createMockQueryBuilder();
    (cardsQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "card1", streamer_id: "streamer1", collection_name: null },
      error: null,
    });
    let streamerCalls = 0;
    const fromMock = vi.fn((table: string) => {
      if (table === "streamers") {
        streamerCalls += 1;
        return streamerCalls === 1 ? streamerQuery : retryStreamerQuery;
      }
      return cardsQuery;
    });

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        streamerId: "streamer1",
        name: "Sword",
        description: "",
        imageUrl: "https://example.com/a.png",
        rarity: "common",
        dropRate: 0.5,
        collectionName: "weapons",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.collectionNameSkippedDeployWindow).toBe(true);
    expect(cardsQuery.insert).toHaveBeenCalledWith(
      expect.not.objectContaining({ collection_name: expect.anything() })
    );
  });
});

describe("PUT /api/cards/[id] card-pack membership validation (Issue #393再設計)", () => {
  function buildCardQuery(currentCollectionName: string | null, registeredPackNames: string[]) {
    const cardQuery = createMockQueryBuilder();
    (cardQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        streamer_id: "streamer1",
        image_url: null,
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
        collection_name: currentCollectionName,
        streamers: { twitch_user_id: "user1", rarity_weights: null, card_pack_names: registeredPackNames },
      },
      error: null,
    });
    return cardQuery;
  }

  it("rejects changing to an unregistered pack name (400)", async () => {
    const selectQuery = buildCardQuery("weapons", ["weapons", "characters"]);
    const updateQuery = createMockQueryBuilder();
    const fromMock = vi.fn(() => selectQuery);

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards/card1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", collectionName: "armor" }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "card1" }) });
    expect(response.status).toBe(400);
    expect(updateQuery.update).not.toHaveBeenCalled();
  });

  // Issue #555: same reservation applies to card updates — a card's own
  // default-pack membership is expressed by collection_name = NULL, never by
  // the DEFAULT_PACK_SENTINEL filter value.
  it("rejects changing to DEFAULT_PACK_SENTINEL (400) — cards use null, not the sentinel", async () => {
    const selectQuery = buildCardQuery("weapons", ["weapons", "characters"]);
    const updateQuery = createMockQueryBuilder();
    const fromMock = vi.fn(() => selectQuery);

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards/card1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", collectionName: DEFAULT_PACK_SENTINEL }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "card1" }) });
    expect(response.status).toBe(400);
    expect(updateQuery.update).not.toHaveBeenCalled();
  });

  it("persists changing to a different REGISTERED pack name (200)", async () => {
    const selectQuery = buildCardQuery("weapons", ["weapons", "characters"]);
    const updateQuery = createMockQueryBuilder();
    (updateQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "card1", collection_name: "characters" },
      error: null,
    });
    let callCount = 0;
    const fromMock = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? selectQuery : updateQuery;
    });

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards/card1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collectionName: "characters" }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "card1" }) });
    expect(response.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: "characters" })
    );
  });

  it("allows resubmitting the SAME pack value even if it was since removed from the registered list (orphaned pack)", async () => {
    // "weapons" is the card's current value but is no longer in card_pack_names
    // (removed via pack management) — unrelated edits must not 400.
    const selectQuery = buildCardQuery("weapons", ["characters"]);
    const updateQuery = createMockQueryBuilder();
    (updateQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "card1", name: "Renamed", collection_name: "weapons" },
      error: null,
    });
    let callCount = 0;
    const fromMock = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? selectQuery : updateQuery;
    });

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards/card1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", collectionName: "weapons" }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "card1" }) });
    expect(response.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed", collection_name: "weapons" })
    );
  });

  it("allows clearing an existing pack to null regardless of the registered list", async () => {
    const selectQuery = buildCardQuery("weapons", []);
    const updateQuery = createMockQueryBuilder();
    (updateQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "card1", collection_name: null },
      error: null,
    });
    let callCount = 0;
    const fromMock = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? selectQuery : updateQuery;
    });

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards/card1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collectionName: null }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "card1" }) });
    expect(response.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: null })
    );
  });

  // Self-review regression guard (carried over from #269): the ownership-check
  // SELECT reads collection_name AND card_pack_names. Either column being
  // undeployed must not 403/break unrelated edits.
  it("still updates the card when card_pack_names is not deployed yet (deploy window)", async () => {
    const selectQuery = createMockQueryBuilder();
    (selectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { code: "42703", message: "column streamers.card_pack_names does not exist" },
    });
    const retrySelectQuery = createMockQueryBuilder();
    (retrySelectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        streamer_id: "streamer1",
        image_url: null,
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
        collection_name: "weapons",
        streamers: { twitch_user_id: "user1", rarity_weights: null },
      },
      error: null,
    });
    const updateQuery = createMockQueryBuilder();
    (updateQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "card1", name: "Renamed" },
      error: null,
    });
    let selectCalls = 0;
    const fromMock = vi.fn(() => {
      selectCalls += 1;
      if (selectCalls === 1) return selectQuery;
      if (selectCalls === 2) return retrySelectQuery;
      return updateQuery;
    });

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards/card1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "card1" }) });
    expect(response.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed" })
    );
  });

  it("drops a NEW pack change when card_pack_names is not deployed yet, but keeps other field edits (deploy window)", async () => {
    const selectQuery = createMockQueryBuilder();
    (selectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { code: "42703", message: "column streamers.card_pack_names does not exist" },
    });
    const retrySelectQuery = createMockQueryBuilder();
    (retrySelectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        streamer_id: "streamer1",
        image_url: null,
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
        collection_name: "weapons",
        streamers: { twitch_user_id: "user1", rarity_weights: null },
      },
      error: null,
    });
    const updateQuery = createMockQueryBuilder();
    (updateQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "card1", name: "Renamed", collection_name: "weapons" },
      error: null,
    });
    let selectCalls = 0;
    const fromMock = vi.fn(() => {
      selectCalls += 1;
      if (selectCalls === 1) return selectQuery;
      if (selectCalls === 2) return retrySelectQuery;
      return updateQuery;
    });

    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new NextRequest("http://localhost/api/cards/card1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", collectionName: "armor" }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "card1" }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.collectionNameSkippedDeployWindow).toBe(true);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed" })
    );
    const updateCall = (updateQuery.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall).not.toHaveProperty("collection_name");
  });
});
