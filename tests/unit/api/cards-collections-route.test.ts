import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/cards/collections/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createMockQueryBuilder } from "../../utils/supabase-mock";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);

function makeRequest(streamerId?: string) {
  const url = streamerId
    ? `http://localhost/api/cards/collections?streamerId=${streamerId}`
    : "http://localhost/api/cards/collections";
  return new NextRequest(url);
}

// Issue #393再設計: データソースは streamers.card_pack_names(事前登録一覧)。
// GETは所有権確認と同一クエリでこの列も取得する。
function mockAdmin(opts: {
  streamer?: { id: string; card_pack_names?: string[] } | null;
  streamerError?: unknown;
  fallbackStreamer?: { id: string } | null;
}) {
  const streamerQuery = createMockQueryBuilder();
  (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: opts.streamer ?? null,
    error: opts.streamerError ?? null,
  });
  const fallbackQuery = createMockQueryBuilder();
  (fallbackQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: opts.fallbackStreamer ?? null,
    error: null,
  });
  let calls = 0;
  mockGetSupabaseAdmin.mockReturnValue({
    from: vi.fn(() => {
      calls += 1;
      return calls === 1 ? streamerQuery : fallbackQuery;
    }),
  } as unknown as ReturnType<typeof getSupabaseAdmin>);

  return { streamerQuery, fallbackQuery };
}

describe("GET /api/cards/collections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      twitchUserId: "twitch-1",
      twitchUsername: "streamer",
      twitchDisplayName: "Streamer",
      twitchProfileImageUrl: "",
      broadcasterType: "affiliate",
      expiresAt: Date.now() + 60_000,
      version: 1,
    });
    mockCanUseStreamerFeatures.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 100,
      remaining: 99,
      reset: Date.now() + 60_000,
    });
  });

  it("returns the streamer's pre-defined pack names", async () => {
    mockAdmin({
      streamer: { id: "streamer-1", card_pack_names: ["weapons", "characters"] },
    });

    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collections).toEqual(["weapons", "characters"]);
  });

  it("returns an empty list when no packs are registered", async () => {
    mockAdmin({
      streamer: { id: "streamer-1", card_pack_names: [] },
    });

    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collections).toEqual([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session cannot use streamer features", async () => {
    mockCanUseStreamerFeatures.mockReturnValue(false);
    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when streamerId is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it("returns 403 when the session does not own the streamer", async () => {
    mockAdmin({ streamer: null });
    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 100,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 30,
    });
    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(429);
  });

  it("returns an empty list when card_pack_names is not deployed yet (READ 42703), after confirming ownership", async () => {
    // Real PostgREST returns 42703 ("does not exist") for a SELECT on a missing
    // column, not PGRST204 — the deploy-window fallback must accept that shape,
    // and must still verify ownership via a fallback query before responding.
    mockAdmin({
      streamer: undefined,
      streamerError: { code: "42703", message: "column streamers.card_pack_names does not exist" },
      fallbackStreamer: { id: "streamer-1" },
    });
    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collections).toEqual([]);
  });

  it("returns 403 during the deploy window if the session does not own the streamer", async () => {
    mockAdmin({
      streamer: undefined,
      streamerError: { code: "42703", message: "column streamers.card_pack_names does not exist" },
      fallbackStreamer: null,
    });
    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(403);
  });
});
