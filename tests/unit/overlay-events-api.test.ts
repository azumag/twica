import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { GET } from "@/app/api/overlay/[streamerId]/events/route";
import { checkRateLimit } from "@/lib/rate-limit";
import { getDb } from "@/lib/db/client";
import {
  gachaHistory as gachaHistoryTable,
  cards as cardsTable,
} from "@/lib/db/schema";
import {
  __clearOverlayDemoEventsForTests,
  publishOverlayDemoEvent,
} from "@/lib/overlay/demo-event-store";

vi.mock("@/lib/rate-limit");
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}));

const STREAMER_ID = "123e4567-e89b-42d3-a456-426614174000";
const SINCE = "2026-01-01T00:00:00.000Z";
const mockCheckRateLimit = vi.mocked(checkRateLimit);

interface QueryCall {
  fields: Record<string, unknown>;
  fromTable?: unknown;
  joinTable?: unknown;
  joinCondition?: unknown;
  whereCondition?: unknown;
  orderByConditions?: unknown[];
  limitValue?: number;
}

/**
 * Drizzle の fluent chain を記録し、選択列だけを fixture から射影する。
 * 実装が reward_id を選び忘れた場合や、streamer 条件・複合カーソル・上限を
 * 変更した場合にレスポンスだけでなくクエリ契約のテストも失敗する。
 */
function createDbMock(
  responses: Array<{ rows?: Record<string, unknown>[]; error?: unknown }>
) {
  let responseIndex = 0;
  const calls: QueryCall[] = [];
  const select = vi.fn((fields: Record<string, unknown>) => {
    const call: QueryCall = { fields };
    calls.push(call);
    const builder = {
      from(table: unknown) {
        call.fromTable = table;
        return builder;
      },
      leftJoin(table: unknown, condition: unknown) {
        call.joinTable = table;
        call.joinCondition = condition;
        return builder;
      },
      where(condition: unknown) {
        call.whereCondition = condition;
        return builder;
      },
      orderBy(...conditions: unknown[]) {
        call.orderByConditions = conditions;
        return builder;
      },
      limit(limit: number) {
        call.limitValue = limit;
        const response =
          responses[Math.min(responseIndex, responses.length - 1)];
        responseIndex += 1;
        if (response.error) return Promise.reject(response.error);
        return Promise.resolve(
          (response.rows ?? []).map((row) =>
            Object.fromEntries(
              Object.keys(fields).map((key) => [key, row[key]])
            )
          )
        );
      },
    };
    return builder;
  });
  return { select, calls };
}

function useRows(rows: Record<string, unknown>[]) {
  const db = createDbMock([{ rows }]);
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as never);
  return db;
}

function createRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL(
    `http://localhost/api/overlay/${STREAMER_ID}/events`
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

function routeParams(streamerId = STREAMER_ID) {
  return { params: Promise.resolve({ streamerId }) };
}

const DISPLAY_ROW = {
  id: "history-1",
  event_id: "event-1",
  redeemed_at: "2026-01-01T00:00:01.000Z",
  user_twitch_username: "viewer",
  reward_id: "reward-1",
  card_id: "card-1",
  card_name: "Card",
  card_description: null,
  card_image_url: null,
  card_rarity: "rare",
};

describe("GET /api/overlay/[streamerId]/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearOverlayDemoEventsForTests();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 120,
      remaining: 119,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("不正な streamer、since、demoSince、afterId をDB接続前に拒否する", async () => {
    const invalidStreamer = await GET(
      createRequest({ since: SINCE }),
      routeParams("not-a-uuid")
    );
    const missingSince = await GET(createRequest(), routeParams());
    const invalidAfterId = await GET(
      createRequest({
        since: SINCE,
        afterId: "bad),streamer_id.eq.other",
      }),
      routeParams()
    );
    const invalidDemoSince = await GET(
      createRequest({ since: SINCE, demoSince: "invalid" }),
      routeParams()
    );

    expect(invalidStreamer.status).toBe(400);
    expect(missingSince.status).toBe(400);
    expect(invalidAfterId.status).toBe(400);
    expect(invalidDemoSince.status).toBe(400);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("rate limitの本文とheadersを維持しDBへ接続しない", async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 120,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 30,
    });

    const response = await GET(
      createRequest({ since: SINCE }),
      routeParams()
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toMatchObject({ error: expect.any(String) });
    expect(response.headers.get("X-RateLimit-Limit")).toBe("120");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(getDb).not.toHaveBeenCalled();
  });

  it("legacy応答でreward_idとカードを返し、非表示tailまでcursorを進める", async () => {
    const missingCardTail = {
      ...DISPLAY_ROW,
      id: "history-2",
      event_id: "event-2",
      redeemed_at: "2026-01-01T00:00:02.000Z",
      card_id: null,
      card_name: null,
      card_rarity: null,
    };
    useRows([DISPLAY_ROW, missingCardTail]);

    const response = await GET(
      createRequest({ since: SINCE }),
      routeParams()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.events).toEqual([
      {
        id: "history-1",
        eventId: "event-1",
        redeemedAt: "2026-01-01T00:00:01.000Z",
        userTwitchUsername: "viewer",
        rewardId: "reward-1",
        card: {
          id: "card-1",
          name: "Card",
          description: null,
          image_url: null,
          rarity: "rare",
        },
      },
    ]);
    expect(body.nextCursor).toEqual({
      redeemedAt: missingCardTail.redeemed_at,
      historyId: missingCardTail.id,
    });
    expect(body.realtimeEvents).toBeUndefined();
  });

  it("V1応答と同一timestamp用の複合cursor条件を返す", async () => {
    const afterId = "123e4567-e89b-42d3-a456-426614174001";
    const db = useRows([DISPLAY_ROW]);

    const response = await GET(
      createRequest({ since: SINCE, afterId, contract: "v1" }),
      routeParams()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(db.calls[0].whereCondition).toEqual(
      and(
        eq(gachaHistoryTable.streamer_id, STREAMER_ID),
        or(
          gt(gachaHistoryTable.redeemed_at, SINCE),
          and(
            eq(gachaHistoryTable.redeemed_at, SINCE),
            gt(gachaHistoryTable.id, afterId)
          )
        )
      )
    );
    expect(body.events).toBeUndefined();
    expect(body.realtimeEvents[0]).toMatchObject({
      schemaVersion: 1,
      eventId: "event-1",
      streamerId: STREAMER_ID,
      soundGroupId: "event-1",
    });
  });

  it("前レスポンスのPostgreSQLマイクロ秒cursorを正規化して次のqueryへ渡す", async () => {
    const afterId = "123e4567-e89b-42d3-a456-426614174001";
    const postgresCursor = "2026-07-24T14:40:14.511943+00:00";
    const normalizedCursor = "2026-07-24T14:40:14.511943Z";
    const db = useRows([]);

    // createRequest はoverlayのnextCursor往復と同じくURLSearchParamsを使う。
    // これにより、以前は不正なsince値として拒否された+00:00 offsetのエンコードを
    // 実際のリクエスト経路のまま検証できる。
    const response = await GET(
      createRequest({ since: postgresCursor, afterId }),
      routeParams()
    );

    expect(response.status).toBe(200);
    expect(db.calls[0].whereCondition).toEqual(
      and(
        eq(gachaHistoryTable.streamer_id, STREAMER_ID),
        or(
          gt(gachaHistoryTable.redeemed_at, normalizedCursor),
          and(
            eq(gachaHistoryTable.redeemed_at, normalizedCursor),
            gt(gachaHistoryTable.id, afterId)
          )
        )
      )
    );
  });

  it("Cloudflareで+が空白化されたPostgreSQL cursorを正規化してqueryへ渡す", async () => {
    const rawPlusCursor = "2026-07-24T14:40:14.511943+00:00";
    const normalizedCursor = "2026-07-24T14:40:14.511943Z";
    const db = useRows([]);

    // 生の+を含むquery stringはURLSearchParamsでSPACEに復号される。この経路を
    // 明示して、CDNやform decoderを通ったpolling cursorも受理する契約を固定する。
    const response = await GET(
      new NextRequest(
        `http://localhost/api/overlay/${STREAMER_ID}/events?since=${rawPlusCursor}`
      ),
      routeParams()
    );

    expect(response.status).toBe(200);
    expect(db.calls[0].whereCondition).toEqual(
      and(
        eq(gachaHistoryTable.streamer_id, STREAMER_ID),
        gt(gachaHistoryTable.redeemed_at, normalizedCursor)
      )
    );
  });

  it("nextCursorはPostgreSQL timestampのマイクロ秒を保持したUTC ISOで返す", async () => {
    const rawPostgresTimestamp = "2026-07-24T14:40:14.511943+00:00";
    useRows([
      {
        ...DISPLAY_ROW,
        redeemed_at: rawPostgresTimestamp,
      },
    ]);

    const response = await GET(
      createRequest({ since: SINCE }),
      routeParams()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nextCursor).toEqual({
      redeemedAt: "2026-07-24T14:40:14.511943Z",
      historyId: DISPLAY_ROW.id,
    });
  });

  it("デモを同じ応答で返すが履歴cursorはPlanetScale行だけで進める", async () => {
    useRows([DISPLAY_ROW]);
    const demoEvent = await publishOverlayDemoEvent(STREAMER_ID, {
      id: "demo-card",
      name: "Demo card",
      description: null,
      image_url: null,
      rarity: "common",
    });

    const response = await GET(
      createRequest({
        since: SINCE,
        demoSince: "2026-01-01T00:00:00.000Z",
        contract: "v1",
      }),
      routeParams()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.demoEvent).toEqual(demoEvent);
    expect(body.nextCursor).toEqual({
      redeemedAt: DISPLAY_ROW.redeemed_at,
      historyId: DISPLAY_ROW.id,
    });
  });

  it("マイクロ秒cursorの次pollは同一行を除外する複合条件を維持する", async () => {
    const rawPostgresTimestamp = "2026-07-24T14:40:14.511943+00:00";
    const historyId = "123e4567-e89b-42d3-a456-426614174001";
    const db = createDbMock([
      {
        rows: [
          {
            ...DISPLAY_ROW,
            id: historyId,
            redeemed_at: rawPostgresTimestamp,
          },
        ],
      },
      { rows: [] },
    ]);
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as never);

    const firstResponse = await GET(
      createRequest({ since: SINCE }),
      routeParams()
    );
    const firstBody = await firstResponse.json();

    expect(firstBody.nextCursor).toEqual({
      redeemedAt: "2026-07-24T14:40:14.511943Z",
      historyId,
    });

    const secondResponse = await GET(
      createRequest({
        since: firstBody.nextCursor.redeemedAt,
        afterId: firstBody.nextCursor.historyId,
      }),
      routeParams()
    );

    expect(secondResponse.status).toBe(200);
    expect(db.calls[1].whereCondition).toEqual(
      and(
        eq(gachaHistoryTable.streamer_id, STREAMER_ID),
        or(
          gt(gachaHistoryTable.redeemed_at, "2026-07-24T14:40:14.511943Z"),
          and(
            eq(gachaHistoryTable.redeemed_at, "2026-07-24T14:40:14.511943Z"),
            gt(gachaHistoryTable.id, historyId)
          )
        )
      )
    );
  });

  it("signed offsetをUTC日付境界をまたいでマイクロ秒まで正規化する", async () => {
    const db = useRows([]);
    const cursors = [
      {
        input: "2026-07-24T00:15:00.123456+09:30",
        expected: "2026-07-23T14:45:00.123456Z",
      },
      {
        input: "2026-07-24T23:30:00.654321-04:00",
        expected: "2026-07-25T03:30:00.654321Z",
      },
    ];

    for (const { input, expected } of cursors) {
      const response = await GET(createRequest({ since: input }), routeParams());
      expect(response.status).toBe(200);
      expect(db.calls.at(-1)?.whereCondition).toEqual(
        and(
          eq(gachaHistoryTable.streamer_id, STREAMER_ID),
          gt(gachaHistoryTable.redeemed_at, expected)
        )
      );
    }
  });

  it("leap dayは受理し、calendar・offset・非ISO入力はDB接続前に拒否する", async () => {
    const db = useRows([]);
    const leapDay = await GET(
      createRequest({ since: "2024-02-29T23:59:59.123456Z" }),
      routeParams()
    );

    expect(leapDay.status).toBe(200);
    expect(db.calls[0].whereCondition).toEqual(
      and(
        eq(gachaHistoryTable.streamer_id, STREAMER_ID),
        gt(gachaHistoryTable.redeemed_at, "2024-02-29T23:59:59.123456Z")
      )
    );

    const invalidCursors = [
      "0000-01-01T00:00:00Z",
      "2024-02-30T00:00:00Z",
      "2024-01-01T24:00:00Z",
      "2024-01-01T00:00:00+24:00",
      "2024-01-01T00:00:00+00:60",
      "0001-01-01T00:00:00+23:59",
      "9999-12-31T23:59:59-23:59",
      "2024-01-01T00:00:00",
      "1721832014511",
      "2024/01/01 00:00:00Z",
    ];
    for (const since of invalidCursors) {
      const response = await GET(createRequest({ since }), routeParams());
      expect(response.status).toBe(400);
    }
    expect(db.calls).toHaveLength(1);
  });

  it("PlanetScale queryが必要列・join・安定順・bounded limitを使う", async () => {
    const db = useRows([]);

    const response = await GET(
      createRequest({ since: SINCE }),
      routeParams()
    );

    expect(response.status).toBe(200);
    expect(db.calls).toHaveLength(1);
    const call = db.calls[0];
    expect(call.fields.reward_id).toBe(gachaHistoryTable.reward_id);
    expect(call.fromTable).toBe(gachaHistoryTable);
    expect(call.joinTable).toBe(cardsTable);
    expect(call.joinCondition).toEqual(
      eq(gachaHistoryTable.card_id, cardsTable.id)
    );
    expect(call.whereCondition).toEqual(
      and(
        eq(gachaHistoryTable.streamer_id, STREAMER_ID),
        gt(gachaHistoryTable.redeemed_at, SINCE)
      )
    );
    expect(call.orderByConditions).toEqual([
      asc(gachaHistoryTable.redeemed_at),
      asc(gachaHistoryTable.id),
    ]);
    expect(call.limitValue).toBe(100);
  });

  it("恒久DBエラーを既存Database error envelopeで返す", async () => {
    const db = createDbMock([
      { error: { code: "42601", message: "syntax error" } },
    ]);
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as never);

    const response = await GET(
      createRequest({ since: SINCE }),
      routeParams()
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Database error",
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("一時DB障害は1回だけ再試行して打ち切る", async () => {
    vi.useFakeTimers();
    const db = createDbMock([
      { error: { code: "08006", message: "connection reset" } },
    ]);
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as never);

    const responsePromise = GET(
      createRequest({ since: SINCE }),
      routeParams()
    );
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("空配列とoverlayVersionの後方互換を維持する", async () => {
    vi.stubEnv("NEXT_PUBLIC_OVERLAY_VERSION", "v-test");
    useRows([]);

    const response = await GET(
      createRequest({ since: SINCE }),
      routeParams()
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      events: [],
      nextCursor: null,
      overlayVersion: "v-test",
      // Rollout/rollback signal the overlay reads instead of polling the config
      // endpoint on its own timer. Without any OVERLAY_REALTIME_* env stubbed,
      // the shared resolver denies by default.
      realtimeConfigVersion: "polling-only-v1",
    });
  });
});
