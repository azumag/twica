/**
 * GET /api/cards の現行 PlanetScale/Drizzle 契約。
 *
 * ソート式・ページング・限定カードの発行数付与を、DB 呼び出し順と分離して
 * 検証する。特に issued_count は限定カードだけを対象にするため、不要な
 * user_cards 問い合わせを増やさないことも回帰条件に含める。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { GET } from "@/app/api/cards/route";
import { getSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db/client";
import { cards as cardsTable } from "@/lib/db/schema";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));

const mockGetSession = vi.mocked(getSession);
const mockCheckRateLimit = vi.mocked(checkRateLimit);

interface SelectResponse {
  rows?: Array<Record<string, unknown>>;
  error?: unknown;
}

function primeDb(selects: SelectResponse[]) {
  let index = 0;
  const calls: Array<{
    fields?: Record<string, unknown>;
    orderBy?: unknown[];
    limit?: number;
    offset?: number;
  }> = [];
  const db = {
    select: vi.fn((fields?: Record<string, unknown>) => {
      const response = selects[Math.min(index++, selects.length - 1)];
      const call: (typeof calls)[number] = { fields };
      calls.push(call);
      const resolve = () => {
        if (response.error) return Promise.reject(response.error);
        const rows = response.rows ?? [];
        return Promise.resolve(
          fields
            ? rows.map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null])),
              )
            : rows,
        );
      };
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn((...expressions: unknown[]) => {
          call.orderBy = expressions;
          return builder;
        }),
        limit: vi.fn((value: number) => {
          call.limit = value;
          return builder;
        }),
        offset: vi.fn((value: number) => {
          call.offset = value;
          return builder;
        }),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };
  vi.mocked(getDb).mockResolvedValue({ db, sql: vi.fn() } as any);
  return { db, calls };
}

const SESSION = {
  twitchUserId: "user-1",
  twitchUsername: "streamer",
  twitchDisplayName: "Streamer",
  twitchProfileImageUrl: "",
  broadcasterType: "affiliate" as const,
  expiresAt: Date.now() + 60_000,
  version: 1,
};

const BASE_CARD = {
  id: "card-1",
  streamer_id: "streamer-1",
  name: "Card",
  rarity: "common",
  rarity_order: 4,
  drop_rate: 0.5,
  card_number: 1,
  max_issuance_count: null,
  created_at: "2026-01-01T00:00:00Z",
};

function request(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/cards");
  url.searchParams.set("streamerId", "streamer-1");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new NextRequest(url);
}

function primeCards(
  rows: Array<Record<string, unknown>> = [BASE_CARD],
  extra: SelectResponse[] = [],
) {
  return primeDb([
    { rows: [{ id: "streamer-1" }] },
    { rows: [{ count: rows.length }] },
    { rows },
    ...extra,
  ]);
}

function rowQueryCall(calls: ReturnType<typeof primeDb>["calls"]) {
  return calls.find((call) => call.orderBy !== undefined)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(SESSION);
  mockCheckRateLimit.mockResolvedValue({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60_000,
  });
});

describe("GET /api/cards sort field mapping", () => {
  it("sortField=rarity uses rarity_order", async () => {
    const mock = primeCards();
    expect((await GET(request({ sortField: "rarity", sortDirection: "asc" }))).status).toBe(200);
    expect(rowQueryCall(mock.calls).orderBy).toEqual([
      sql`${cardsTable.rarity_order} ASC NULLS LAST`,
    ]);
  });

  it("sortField=created_at uses created_at", async () => {
    const mock = primeCards();
    await GET(request({ sortField: "created_at", sortDirection: "asc" }));
    expect(rowQueryCall(mock.calls).orderBy).toEqual([
      sql`${cardsTable.created_at} ASC NULLS LAST`,
    ]);
  });

  it("sortField=drop_rate uses drop_rate", async () => {
    const mock = primeCards();
    await GET(request({ sortField: "drop_rate", sortDirection: "asc" }));
    expect(rowQueryCall(mock.calls).orderBy).toEqual([
      sql`${cardsTable.drop_rate} ASC NULLS LAST`,
    ]);
  });

  it("sortField=card_number uses card_number", async () => {
    const mock = primeCards();
    await GET(request({ sortField: "card_number", sortDirection: "asc" }));
    expect(rowQueryCall(mock.calls).orderBy).toEqual([
      sql`${cardsTable.card_number} ASC NULLS LAST`,
    ]);
  });

  it("display_order adds created_at ascending as a stable tie-breaker", async () => {
    const mock = primeCards();
    await GET(request({ sortField: "display_order" }));
    expect(rowQueryCall(mock.calls).orderBy).toEqual([
      sql`${cardsTable.card_number} DESC NULLS LAST`,
      sql`${cardsTable.created_at} ASC NULLS LAST`,
    ]);
  });

  it("missing card_number falls back to created_at", async () => {
    const mock = primeDb([
      { rows: [{ id: "streamer-1" }] },
      { rows: [{ count: 1 }] },
      { error: { code: "42703", message: 'column "card_number" does not exist' } },
      { rows: [BASE_CARD] },
    ]);
    const response = await GET(request({ sortField: "card_number" }));
    expect(response.status).toBe(200);
    const rowCalls = mock.calls.filter((call) => call.orderBy);
    expect(rowCalls).toHaveLength(2);
    expect(rowCalls[1].orderBy).toEqual([sql`${cardsTable.created_at} DESC NULLS LAST`]);
  });

  it("invalid sortField falls back to created_at", async () => {
    const mock = primeCards();
    await GET(request({ sortField: "invalid" }));
    expect(rowQueryCall(mock.calls).orderBy).toEqual([
      sql`${cardsTable.created_at} DESC NULLS LAST`,
    ]);
  });
});

describe("GET /api/cards pagination and direction", () => {
  it("applies limit and offset at the database", async () => {
    const mock = primeCards();
    await GET(request({ limit: "20", offset: "40", sortField: "rarity" }));
    expect(rowQueryCall(mock.calls)).toMatchObject({ limit: 20, offset: 40 });
  });

  it("asc produces ASC NULLS LAST", async () => {
    const mock = primeCards();
    await GET(request({ sortField: "rarity", sortDirection: "asc" }));
    expect(rowQueryCall(mock.calls).orderBy).toEqual([
      sql`${cardsTable.rarity_order} ASC NULLS LAST`,
    ]);
  });

  it("desc produces DESC NULLS LAST", async () => {
    const mock = primeCards();
    await GET(request({ sortField: "rarity", sortDirection: "desc" }));
    expect(rowQueryCall(mock.calls).orderBy).toEqual([
      sql`${cardsTable.rarity_order} DESC NULLS LAST`,
    ]);
  });

  it("invalid sortDirection falls back to desc", async () => {
    const mock = primeCards();
    await GET(request({ sortField: "rarity", sortDirection: "invalid" }));
    expect(rowQueryCall(mock.calls).orderBy).toEqual([
      sql`${cardsTable.rarity_order} DESC NULLS LAST`,
    ]);
  });
});

describe("GET /api/cards errors", () => {
  it("returns 400 when streamerId is missing", async () => {
    expect((await GET(new NextRequest("http://localhost/api/cards"))).status).toBe(400);
  });

  it("returns 403 when the streamer is not owned", async () => {
    primeDb([{ rows: [] }]);
    expect((await GET(request())).status).toBe(403);
  });
});

describe("GET /api/cards issued_count", () => {
  it("skips user_cards for unlimited cards", async () => {
    const mock = primeCards([{ ...BASE_CARD, max_issuance_count: null }]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mock.calls).toHaveLength(3);
    expect((await response.json()).cards[0]).not.toHaveProperty("issued_count");
  });

  it("counts only user_cards belonging to limited cards", async () => {
    const limited = { ...BASE_CARD, max_issuance_count: 3 };
    const unlimited = { ...BASE_CARD, id: "card-2", max_issuance_count: null };
    const mock = primeCards(
      [limited, unlimited],
      [{ rows: [{ card_id: "card-1" }, { card_id: "card-1" }] }],
    );
    const body = await (await GET(request())).json();
    expect(mock.calls).toHaveLength(4);
    expect(body.cards[0].issued_count).toBe(2);
    expect(body.cards[1]).not.toHaveProperty("issued_count");
  });

  it("sets issued_count to zero when a limited card has no issues", async () => {
    primeCards([{ ...BASE_CARD, max_issuance_count: 3 }], [{ rows: [] }]);
    const body = await (await GET(request())).json();
    expect(body.cards[0].issued_count).toBe(0);
  });

  it("returns cards without issued_count when user_cards lookup fails", async () => {
    primeCards(
      [{ ...BASE_CARD, max_issuance_count: 3 }],
      [{ error: { code: "XX000", message: "lookup failed" } }],
    );
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).cards[0]).not.toHaveProperty("issued_count");
  });
});
