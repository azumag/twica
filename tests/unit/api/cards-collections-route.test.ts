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

function thenable(data: unknown, error: unknown = null) {
  const q = createMockQueryBuilder();
  ;(q as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
    resolve({ data, error });
    return q;
  };
  return q;
}

function makeRequest(streamerId?: string) {
  const url = streamerId
    ? `http://localhost/api/cards/collections?streamerId=${streamerId}`
    : "http://localhost/api/cards/collections";
  return new NextRequest(url);
}

// streamer ownership query resolves via maybeSingle; the cards query is thenable.
function mockAdmin(opts: {
  streamer?: { id: string } | null;
  streamerError?: unknown;
  cards?: Array<{ collection_name: string | null }>;
  cardsError?: unknown;
}) {
  const streamerQuery = createMockQueryBuilder();
  ;(streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: opts.streamer ?? null,
    error: opts.streamerError ?? null,
  });
  const cardsQuery = thenable(opts.cards ?? [], opts.cardsError ?? null);

  mockGetSupabaseAdmin.mockReturnValue({
    from: vi.fn((table: string) => (table === "streamers" ? streamerQuery : cardsQuery)),
  } as unknown as ReturnType<typeof getSupabaseAdmin>);

  return { streamerQuery, cardsQuery };
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

  it("returns distinct, sorted pack names for active cards", async () => {
    mockAdmin({
      streamer: { id: "streamer-1" },
      cards: [
        { collection_name: "weapons" },
        { collection_name: "characters" },
        { collection_name: "weapons" },
        { collection_name: " characters " },
      ],
    });

    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collections).toEqual(["characters", "weapons"]);
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

  it("returns an empty list when the collection_name column is not deployed yet (READ 42703)", async () => {
    // Real PostgREST returns 42703 ("does not exist") for a SELECT on a missing
    // column, not PGRST204 — so the deploy-window fallback must accept that shape.
    mockAdmin({
      streamer: { id: "streamer-1" },
      cardsError: { code: "42703", message: "column cards.collection_name does not exist" },
    });
    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collections).toEqual([]);
  });
});
