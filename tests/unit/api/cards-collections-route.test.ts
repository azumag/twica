import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { GET, PATCH } from "@/app/api/cards/collections/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db/client";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");

const mockGetSession = vi.mocked(getSession);
const mockCanUseStreamerFeatures = vi.mocked(canUseStreamerFeatures);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
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
  const responses = [
    opts.streamerError
      ? { error: opts.streamerError }
      : { rows: opts.streamer ? [opts.streamer] : [] },
    { rows: opts.fallbackStreamer ? [opts.fallbackStreamer] : [] },
  ];
  let selectIndex = 0;
  const whereExpressions: unknown[] = [];
  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const response = responses[Math.min(selectIndex++, responses.length - 1)];
      const resolve = () => {
        if ("error" in response) return Promise.reject(response.error);
        return Promise.resolve(
          response.rows.map((row) =>
            Object.fromEntries(
              Object.keys(fields).map((key) => [key, row[key as keyof typeof row] ?? null]),
            ),
          ),
        );
      };
      const builder = {
        from: vi.fn(),
        where: vi.fn((expression: unknown) => {
          whereExpressions.push(expression);
          return builder;
        }),
        limit: vi.fn(),
        then: (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) =>
          resolve().then(onFulfilled, onRejected),
      };
      builder.from.mockReturnValue(builder);
      builder.limit.mockReturnValue(builder);
      return builder;
    }),
  };
  vi.mocked(getDb).mockResolvedValue({ db, sql: vi.fn() } as never);
  return { db, whereExpressions };
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
    const { whereExpressions } = mockAdmin({
      streamer: { id: "streamer-1", card_pack_names: ["weapons", "characters"] },
    });

    const res = await GET(makeRequest("streamer-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collections).toEqual(["weapons", "characters"]);

    // 認可境界は streamerId だけでなく、ログイン中の twitch_user_id も同じ
    // WHERE に束縛する。SQL化して両カラムと両bind値を固定し、片方を落とす
    // 回帰(他人のcatalog参照)を防ぐ。
    const ownershipQuery = new MySqlDialect().sqlToQuery(whereExpressions[0] as never);
    expect(ownershipQuery.sql).toContain("`streamers`.`id`");
    expect(ownershipQuery.sql).toContain("`streamers`.`twitch_user_id`");
    expect(ownershipQuery.params).toEqual(["streamer-1", "twitch-1"]);
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
    // PostgreSQL returns 42703 ("does not exist") for a SELECT on a missing
    // column — the deploy-window fallback must accept that shape,
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
  fallbackStreamer?: { id: string } | null;
  rpcError?: unknown;
}) {
  const dbMock = mockAdmin({
    streamer: opts.streamer,
    streamerError: opts.streamerError,
    fallbackStreamer: opts.fallbackStreamer,
  });
  // postgres.js は PostgREST の `{ error }` 応答ではなく例外を投げる。
  // code と message を持つ Error に正規化し、ルートの実運用エラー分類を再現する。
  const sqlMock = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    void _strings;
    void values;
    if (opts.rpcError) {
      const source = opts.rpcError as { code?: unknown; message?: unknown };
      throw Object.assign(
        new Error(typeof source.message === "string" ? source.message : String(opts.rpcError)),
        { code: typeof source.code === "string" ? source.code : undefined },
      );
    }
    return [];
  });
  vi.mocked(getDb).mockResolvedValue({ db: dbMock.db, sql: sqlMock } as never);
  return { db: dbMock.db, sqlMock };
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
    const { sqlMock } = mockAdminForPatch({
      streamer: { id: "streamer-1", card_pack_names: ["weapons", "characters"] },
    });

    const res = await PATCH(
      makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "  armory  " })
    );

    expect(res.status).toBe(200);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls[0].slice(1)).toEqual(["streamer-1", "weapons", "armory"]);
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
    const { sqlMock } = mockAdminForPatch({
      streamer: undefined,
      streamerError: { code: "42703", message: "column streamers.card_pack_names does not exist" },
      fallbackStreamer: { id: "streamer-1" },
    });

    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(503);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("returns 403 rather than 503 when the 42703 fallback finds no owned streamer", async () => {
    const { sqlMock } = mockAdminForPatch({
      streamer: undefined,
      streamerError: { code: "42703", message: "column streamers.card_pack_names does not exist" },
      fallbackStreamer: null,
    });

    const res = await PATCH(makePatchRequest({ streamerId: "streamer-1", oldName: "weapons", newName: "armory" }));
    expect(res.status).toBe(403);
    expect(sqlMock).not.toHaveBeenCalled();
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
