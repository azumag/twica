// Issue #269: premium gate for card-pack (collection_name) assignment on the
// cards POST (create) and PUT (update) endpoints. Scoped to the gate's
// behavior only — broader CRUD coverage for these routes is a pre-existing
// gap outside this change.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/cards/route";
import { PUT } from "@/app/api/cards/[id]/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { getUserPlan } from "@/lib/plan";
import { getStorageUsage } from "@/lib/storage-usage";
import { createMockQueryBuilder } from "../../utils/supabase-mock";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/storage-usage");
// Issue #269: getUserPlan defaults to premium below so only gate-specific
// tests exercise the basic-plan path.
vi.mock("@/lib/plan");
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockGetUserPlan = vi.mocked(getUserPlan);
const mockGetStorageUsage = vi.mocked(getStorageUsage);

const SESSION = {
  twitchUserId: "user1",
  twitchUsername: "streamer",
  twitchDisplayName: "Streamer",
  twitchProfileImageUrl: null,
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
  mockGetUserPlan.mockResolvedValue("support");
});

describe("POST /api/cards card-pack premium gate (Issue #269)", () => {
  it("drops a NEW pack assignment on the basic plan but still creates the card (200, flag set)", async () => {
    mockGetUserPlan.mockResolvedValue("basic");
    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "streamer1", rarity_weights: null },
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
        collectionName: "weapons",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.collectionNamePremiumRequired).toBe(true);
    expect(cardsQuery.insert).toHaveBeenCalledWith(
      expect.not.objectContaining({ collection_name: expect.anything() })
    );
  });

  it("persists the pack assignment on a premium plan (no flag)", async () => {
    mockGetUserPlan.mockResolvedValue("support");
    const streamerQuery = createMockQueryBuilder();
    (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "streamer1", rarity_weights: null },
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
    const data = await response.json();
    expect(data.collectionNamePremiumRequired).toBeUndefined();
    expect(cardsQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: "weapons" })
    );
  });
});

describe("PUT /api/cards/[id] card-pack premium gate (Issue #269)", () => {
  function buildCardQuery(currentCollectionName: string | null) {
    const cardQuery = createMockQueryBuilder();
    (cardQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        streamer_id: "streamer1",
        image_url: null,
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
        collection_name: currentCollectionName,
        streamers: { twitch_user_id: "user1", rarity_weights: null },
      },
      error: null,
    });
    return cardQuery;
  }

  it("drops a change to a NEW pack value on the basic plan but still updates other fields (200, flag set)", async () => {
    mockGetUserPlan.mockResolvedValue("basic");
    const selectQuery = buildCardQuery("weapons");
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
      body: JSON.stringify({ name: "Renamed", collectionName: "armor" }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "card1" }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.collectionNamePremiumRequired).toBe(true);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed" })
    );
    const updateCall = (updateQuery.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateCall).not.toHaveProperty("collection_name");
  });

  it("allows resubmitting the SAME pack value on the basic plan (no-op, no gate)", async () => {
    mockGetUserPlan.mockResolvedValue("basic");
    const selectQuery = buildCardQuery("weapons");
    const updateQuery = createMockQueryBuilder();
    (updateQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { id: "card1", collection_name: "weapons" },
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
      body: JSON.stringify({ collectionName: "weapons" }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "card1" }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.collectionNamePremiumRequired).toBeUndefined();
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: "weapons" })
    );
    expect(mockGetUserPlan).not.toHaveBeenCalled();
  });

  it("allows clearing an existing pack to null on the basic plan", async () => {
    mockGetUserPlan.mockResolvedValue("basic");
    const selectQuery = buildCardQuery("weapons");
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
    const data = await response.json();
    expect(data.collectionNamePremiumRequired).toBeUndefined();
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: null })
    );
    expect(mockGetUserPlan).not.toHaveBeenCalled();
  });

  // Self-review regression guard: the ownership-check SELECT now also reads
  // collection_name for the gate's currentValue. If that column isn't
  // migrated yet, the SELECT itself errors (42703) and must NOT 403 an
  // otherwise-valid edit that has nothing to do with packs.
  it("still updates the card when the collection_name column is not deployed yet (deploy window)", async () => {
    const selectQuery = createMockQueryBuilder();
    (selectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { code: "42703", message: "column cards.collection_name does not exist" },
    });
    const retrySelectQuery = createMockQueryBuilder();
    (retrySelectQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        streamer_id: "streamer1",
        image_url: null,
        rarity: "common",
        is_active: true,
        intra_rarity_weight: 1,
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
});
