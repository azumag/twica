/**
 * Issue #393/#555: カードの collection_name は streamers.card_pack_names に
 * 登録済みでなければならず、既定パックは予約文字列ではなく NULL で表現する。
 *
 * 旧 PostgREST fixture は廃止し、現行の Drizzle JOIN/INSERT/UPDATE 境界を直接
 * モックする。DB が返す行と書き込み値を別々に記録することで、レスポンスだけが
 * 正しく見えて実際の永続化値が誤る回帰も検出する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/cards/route";
import { PUT } from "@/app/api/cards/[id]/route";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { getStorageUsage } from "@/lib/storage-usage";
import { getDb } from "@/lib/db/client";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/storage-usage");

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

interface DbResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function createDbMock(config: {
  selects?: DbResponse[];
  inserts?: DbResponse[];
  updates?: DbResponse[];
}) {
  let selectIndex = 0;
  let insertIndex = 0;
  let updateIndex = 0;
  const insertCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];

  const mapRows = (rows: Array<Record<string, unknown>>, fields?: Record<string, unknown>) =>
    fields
      ? rows.map((row) =>
          Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null])),
        )
      : rows;

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }];
      const response = responses[Math.min(selectIndex++, responses.length - 1)];
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(mapRows(response.rows ?? [], fields));
      const builder: any = {
        from: vi.fn(() => builder),
        innerJoin: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
    insert: vi.fn(() => {
      const responses = config.inserts ?? [{ rows: [] }];
      const response = responses[Math.min(insertIndex++, responses.length - 1)];
      let returningFields: Record<string, unknown> | undefined;
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(mapRows(response.rows ?? [], returningFields));
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          insertCalls.push(values);
          return builder;
        }),
        returning: vi.fn((fields?: Record<string, unknown>) => {
          returningFields = fields;
          return builder;
        }),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
    update: vi.fn(() => {
      const responses = config.updates ?? [{ rows: [] }];
      const response = responses[Math.min(updateIndex++, responses.length - 1)];
      let returningFields: Record<string, unknown> | undefined;
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(mapRows(response.rows ?? [], returningFields));
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          updateCalls.push(values);
          return builder;
        }),
        where: vi.fn(() => builder),
        returning: vi.fn((fields?: Record<string, unknown>) => {
          returningFields = fields;
          return builder;
        }),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };

  vi.mocked(getDb).mockResolvedValue({ db, sql: vi.fn() } as any);
  return { db, insertCalls, updateCalls };
}

function postRequest(collectionName?: string | null) {
  return new NextRequest("http://localhost/api/cards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      streamerId: "streamer1",
      name: "Sword",
      description: "",
      imageUrl: "https://example.com/a.png",
      rarity: "common",
      dropRate: 0.5,
      ...(collectionName !== undefined ? { collectionName } : {}),
    }),
  });
}

function putRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/cards/card1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function streamerRow(cardPackNames: string[]) {
  return { id: "streamer1", rarity_weights: null, card_pack_names: cardPackNames };
}

function ownershipRow(currentCollectionName: string | null, cardPackNames: string[]) {
  return {
    streamer_id: "streamer1",
    image_url: null,
    rarity: "common",
    is_active: true,
    intra_rarity_weight: 1,
    collection_name: currentCollectionName,
    twitch_user_id: "user1",
    rarity_weights: null,
    card_pack_names: cardPackNames,
  };
}

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
  mockGetStorageUsage.mockResolvedValue({
    planOverLimit: false,
  } as Awaited<ReturnType<typeof getStorageUsage>>);
});

describe("POST /api/cards card-pack membership validation", () => {
  it("rejects an unregistered pack name (400)", async () => {
    const db = createDbMock({ selects: [{ rows: [streamerRow(["characters"])] }] });
    const response = await POST(postRequest("weapons"));
    expect(response.status).toBe(400);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("persists a registered pack name (200)", async () => {
    const db = createDbMock({
      selects: [{ rows: [streamerRow(["weapons"])] }],
      inserts: [{ rows: [{ id: "card1", streamer_id: "streamer1", collection_name: "weapons" }] }],
    });
    const response = await POST(postRequest("weapons"));
    expect(response.status).toBe(200);
    expect(db.insertCalls[0]).toEqual(expect.objectContaining({ collection_name: "weapons" }));
  });

  it("rejects DEFAULT_PACK_SENTINEL as a card collectionName (400)", async () => {
    const db = createDbMock({ selects: [{ rows: [streamerRow(["weapons"])] }] });
    const response = await POST(postRequest(DEFAULT_PACK_SENTINEL));
    expect(response.status).toBe(400);
    expect(db.insertCalls).toHaveLength(0);
  });

  it("allows a null unclassified pack", async () => {
    const db = createDbMock({
      selects: [{ rows: [streamerRow([])] }],
      inserts: [{ rows: [{ id: "card1", streamer_id: "streamer1", collection_name: null }] }],
    });
    const response = await POST(postRequest(null));
    expect(response.status).toBe(200);
    expect(db.insertCalls[0]).toEqual(expect.objectContaining({ collection_name: null }));
  });

  it("drops the pack assignment when card_pack_names is not deployed", async () => {
    const db = createDbMock({
      selects: [
        { error: { code: "42703", message: "column streamers.card_pack_names does not exist" } },
        { rows: [{ id: "streamer1", rarity_weights: null }] },
      ],
      inserts: [{ rows: [{ id: "card1", streamer_id: "streamer1", collection_name: null }] }],
    });
    const response = await POST(postRequest("weapons"));
    expect(response.status).toBe(200);
    expect((await response.json()).collectionNameSkippedDeployWindow).toBe(true);
    expect(db.insertCalls[0]).not.toHaveProperty("collection_name");
  });
});

describe("PUT /api/cards/[id] card-pack membership validation", () => {
  async function put(body: Record<string, unknown>) {
    return PUT(putRequest(body), { params: Promise.resolve({ id: "card1" }) });
  }

  it("rejects changing to an unregistered pack name (400)", async () => {
    const db = createDbMock({ selects: [{ rows: [ownershipRow("weapons", ["weapons", "characters"])] }] });
    const response = await put({ name: "Renamed", collectionName: "armor" });
    expect(response.status).toBe(400);
    expect(db.updateCalls).toHaveLength(0);
  });

  it("rejects changing to DEFAULT_PACK_SENTINEL (400)", async () => {
    const db = createDbMock({ selects: [{ rows: [ownershipRow("weapons", ["weapons", "characters"])] }] });
    const response = await put({ name: "Renamed", collectionName: DEFAULT_PACK_SENTINEL });
    expect(response.status).toBe(400);
    expect(db.updateCalls).toHaveLength(0);
  });

  it("persists changing to a registered pack name (200)", async () => {
    const db = createDbMock({
      selects: [{ rows: [ownershipRow("weapons", ["weapons", "characters"])] }],
      updates: [{ rows: [{ id: "card1", collection_name: "characters" }] }],
    });
    const response = await put({ collectionName: "characters" });
    expect(response.status).toBe(200);
    expect(db.updateCalls[0]).toEqual(expect.objectContaining({ collection_name: "characters" }));
  });

  it("allows resubmitting an orphaned current pack value", async () => {
    const db = createDbMock({
      selects: [{ rows: [ownershipRow("weapons", ["characters"])] }],
      updates: [{ rows: [{ id: "card1", name: "Renamed", collection_name: "weapons" }] }],
    });
    const response = await put({ name: "Renamed", collectionName: "weapons" });
    expect(response.status).toBe(200);
    expect(db.updateCalls[0]).toEqual(
      expect.objectContaining({ name: "Renamed", collection_name: "weapons" }),
    );
  });

  it("allows clearing an existing pack to null", async () => {
    const db = createDbMock({
      selects: [{ rows: [ownershipRow("weapons", [])] }],
      updates: [{ rows: [{ id: "card1", collection_name: null }] }],
    });
    const response = await put({ collectionName: null });
    expect(response.status).toBe(200);
    expect(db.updateCalls[0]).toEqual(expect.objectContaining({ collection_name: null }));
  });

  it("still updates unrelated fields when card_pack_names is not deployed", async () => {
    const fallbackOwnership = ownershipRow("weapons", []);
    delete (fallbackOwnership as Partial<typeof fallbackOwnership>).card_pack_names;
    const db = createDbMock({
      selects: [
        { error: { code: "42703", message: "column streamers.card_pack_names does not exist" } },
        { rows: [fallbackOwnership] },
      ],
      updates: [{ rows: [{ id: "card1", name: "Renamed" }] }],
    });
    const response = await put({ name: "Renamed" });
    expect(response.status).toBe(200);
    expect(db.updateCalls[0]).toEqual(expect.objectContaining({ name: "Renamed" }));
  });

  it("drops a new pack change during deploy window but keeps other edits", async () => {
    const fallbackOwnership = ownershipRow("weapons", []);
    delete (fallbackOwnership as Partial<typeof fallbackOwnership>).card_pack_names;
    const db = createDbMock({
      selects: [
        { error: { code: "42703", message: "column streamers.card_pack_names does not exist" } },
        { rows: [fallbackOwnership] },
      ],
      updates: [{ rows: [{ id: "card1", name: "Renamed", collection_name: "weapons" }] }],
    });
    const response = await put({ name: "Renamed", collectionName: "armor" });
    expect(response.status).toBe(200);
    expect((await response.json()).collectionNameSkippedDeployWindow).toBe(true);
    expect(db.updateCalls[0]).toEqual(expect.objectContaining({ name: "Renamed" }));
    expect(db.updateCalls[0]).not.toHaveProperty("collection_name");
  });
});
