import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "@/app/api/cards/collections/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { createMockQueryBuilder } from "../../utils/supabase-mock";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");
vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockValidateContentType = vi.mocked(validateContentType);

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

// Issue #554: PATCH renames an existing pre-registered pack, cascading via
// the rename_card_pack RPC. Ownership/format/membership are all re-verified
// here BEFORE the RPC is ever called (see route.ts comments).
function makePatchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/cards/collections", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockAdminForPatch(opts: {
  streamer?: { id: string; card_pack_names?: string[] } | null;
  streamerError?: unknown;
  rpcError?: unknown;
}) {
  const streamerQuery = createMockQueryBuilder();
  (streamerQuery.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: opts.streamer ?? null,
    error: opts.streamerError ?? null,
  });
  const rpcMock = vi.fn().mockResolvedValue({ data: null, error: opts.rpcError ?? null });
  mockGetSupabaseAdmin.mockReturnValue({
    from: vi.fn(() => streamerQuery),
    rpc: rpcMock,
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { streamerQuery, rpcMock };
}

describe("PATCH /api/cards/collections", () => {
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
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
    mockValidateContentType.mockReturnValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the CSRF token is invalid", async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false });
    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(403);
  });

  it("returns 403 when the session does not own the streamer", async () => {
    mockAdminForPatch({ streamer: null });
    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(403);
  });

  it("returns 400 for a reserved (`__`-prefixed) newName", async () => {
    mockAdminForPatch({ streamer: { id: "streamer-1", card_pack_names: ["weapons"] } });
    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "__default__" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a newName longer than the max length", async () => {
    mockAdminForPatch({ streamer: { id: "streamer-1", card_pack_names: ["weapons"] } });
    const long = "a".repeat(81);
    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: long }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when newName duplicates an existing catalog entry", async () => {
    mockAdminForPatch({ streamer: { id: "streamer-1", card_pack_names: ["weapons", "characters"] } });
    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "characters" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when oldName is not a registered catalog entry", async () => {
    mockAdminForPatch({ streamer: { id: "streamer-1", card_pack_names: ["characters"] } });
    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(400);
  });

  it("calls the rename_card_pack RPC with the exact validated arguments on success", async () => {
    const { rpcMock } = mockAdminForPatch({
      streamer: { id: "streamer-1", card_pack_names: ["weapons", "characters"] },
    });

    const res = await PATCH(
      makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "  armory  " })
    );

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("rename_card_pack", {
      p_streamer_id: "streamer-1",
      p_old_name: "weapons",
      p_new_name: "armory",
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.cardPackNames).toEqual(["armory", "characters"]);
  });

  it("returns 503 with a 'not ready' response when rename_card_pack is not deployed yet (42883)", async () => {
    mockAdminForPatch({
      streamer: { id: "streamer-1", card_pack_names: ["weapons"] },
      rpcError: { code: "42883", message: "function rename_card_pack(uuid, text, text) does not exist" },
    });

    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(503);
  });

  it("returns 503 when the ownership SELECT itself hits the card_pack_names deploy window", async () => {
    mockAdminForPatch({
      streamer: undefined,
      streamerError: { code: "42703", message: "column streamers.card_pack_names does not exist" },
    });

    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(503);
  });

  it("maps an unexpected RPC error to 500", async () => {
    mockAdminForPatch({
      streamer: { id: "streamer-1", card_pack_names: ["weapons"] },
      rpcError: { code: "XX000", message: "unexpected database error" },
    });

    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(500);
  });

  // レビュー指摘: ルートの事前チェックを通過した後、RPC 実行までの間に並行編集
  // が割り込んだレースでは、RPC 内の再検証(RAISE EXCEPTION)が最後の砦になる。
  // その RAISE メッセージが 400(クライアント修正可能)に正しくマッピングされる
  // 分岐を、代表 2 ケースで固定する。
  it("maps a raced RPC NEW_NAME_ALREADY_EXISTS error (concurrent catalog edit) to 400", async () => {
    mockAdminForPatch({
      // Pre-check passes: "armory" is not in the catalog snapshot the route read...
      streamer: { id: "streamer-1", card_pack_names: ["weapons"] },
      // ...but a concurrent save registered "armory" before the RPC ran.
      rpcError: { code: "P0001", message: "NEW_NAME_ALREADY_EXISTS" },
    });

    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(400);
  });

  it("maps a raced RPC STREAMER_NOT_FOUND error (streamer deleted mid-request) to 400", async () => {
    mockAdminForPatch({
      // Pre-check passes: the ownership SELECT still found the streamer...
      streamer: { id: "streamer-1", card_pack_names: ["weapons"] },
      // ...but the row was deleted before the RPC's SELECT ... FOR UPDATE ran.
      rpcError: { code: "P0001", message: "STREAMER_NOT_FOUND" },
    });

    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 30,
    });
    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(429);
  });
});
