import { beforeEach, describe, expect, it, vi } from "vitest";

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const TRADE_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const RECEIVED_CARD_ID = "33333333-3333-4333-8333-333333333333";
const GIVEN_CARD_ID = "44444444-4444-4444-8444-444444444444";

function rpcSuccess(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    tradeOfferId: TRADE_ID,
    receivedUserCardId: RECEIVED_CARD_ID,
    givenUserCardId: GIVEN_CARD_ID,
    offeredCardSnapshot: { name: "Offered", rarity: "rare", imageUrl: null },
    wantedCardSnapshot: { name: "Wanted", rarity: "common", imageUrl: null },
    completedAt: "2026-10-04T00:00:00.000Z",
    idempotentReplay: false,
    ...overrides,
  };
}

const ACCEPTOR_ID = "55555555-5555-4555-8555-555555555555";
const OFFERER_ID = "66666666-6666-4666-8666-666666666666";
const OFFERED_CARD_ID = "77777777-7777-4777-8777-777777777777";
const WANTED_CARD_ID = "88888888-8888-4888-8888-888888888888";

/** Precheck row of an open offer that passes every API-layer rule. */
function precheckRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "open",
    offererUserId: OFFERER_ID,
    acceptedByUserId: null,
    acceptedRequestId: null,
    offeredCardId: OFFERED_CARD_ID,
    wantedCardId: WANTED_CARD_ID,
    offeredActive: true,
    wantedActive: true,
    offeredVisible: true,
    ...overrides,
  };
}

/**
 * Drizzle select-chain mock. Each db.select() consumes the next rows entry:
 * [0] acceptor lookup (users), [1] precheck offer row.
 */
function createSelectDb(selectRows: Array<Array<Record<string, unknown>>>) {
  let index = 0;
  const calls: Array<{ fields: unknown; where?: unknown }> = [];
  const db = {
    select: vi.fn((fields: unknown) => {
      const call: { fields: unknown; where?: unknown } = { fields };
      calls.push(call);
      const rows = selectRows[index++] ?? [];
      const builder: Record<string, unknown> = {};
      builder.from = () => builder;
      builder.where = (where: unknown) => {
        call.where = where;
        return builder;
      };
      builder.limit = () => builder;
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected);
      return builder;
    }),
  };
  return { db, calls };
}

function primeSql(
  sqlMock: ReturnType<typeof vi.fn>,
  selectRows: Array<Array<Record<string, unknown>>> = [
    [{ id: ACCEPTOR_ID, twitch_user_id: "viewer-1" }],
    [precheckRow()],
  ],
) {
  const selectDb = createSelectDb(selectRows);
  vi.mocked(getDb).mockResolvedValue({ db: selectDb.db, sql: sqlMock } as never);
  return selectDb;
}

const ACCEPT_INPUT = {
  twitchUserId: "viewer-1",
  tradeOfferId: TRADE_ID,
  requestId: REQUEST_ID,
};

describe("acceptTradeOffer (#724)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it("returns the RPC success payload unchanged", async () => {
    const result = rpcSuccess();
    const sqlMock = vi.fn().mockResolvedValue([{ result }]);
    primeSql(sqlMock);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(
      acceptTradeOffer({
        twitchUserId: "viewer-1",
        tradeOfferId: TRADE_ID,
        requestId: REQUEST_ID,
      }),
    ).resolves.toEqual(result);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing success fields", { success: true }],
    ["mismatched trade offer", rpcSuccess({ tradeOfferId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })],
    ["invalid received card id", rpcSuccess({ receivedUserCardId: "not-a-uuid" })],
    ["invalid completion timestamp", rpcSuccess({ completedAt: "not-a-date" })],
    ["invalid replay flag", rpcSuccess({ idempotentReplay: "false" })],
    ["unknown failure code", { success: false, error: "FUTURE_UNKNOWN_ERROR" }],
  ])("fails closed on %s RPC payload", async (_description, result) => {
    const sqlMock = vi.fn().mockResolvedValue([{ result }]);
    primeSql(sqlMock);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(
      acceptTradeOffer({
        twitchUserId: "viewer-1",
        tradeOfferId: TRADE_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toThrow("accept_trade_offer returned an invalid response");
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("retries SQLSTATE 40P01 exactly once with the same requestId", async () => {
    const success = rpcSuccess({ idempotentReplay: true });
    const sqlMock = vi.fn()
      .mockRejectedValueOnce({ code: "40P01" })
      .mockResolvedValueOnce([{ result: success }]);
    primeSql(sqlMock);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(
      acceptTradeOffer({
        twitchUserId: "viewer-1",
        tradeOfferId: TRADE_ID,
        requestId: REQUEST_ID,
      }),
    ).resolves.toEqual(success);

    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(sqlMock.mock.calls[0].slice(1)).toEqual(sqlMock.mock.calls[1].slice(1));
  });

  it("maps a second 40P01 to TRADE_BUSY instead of retrying forever", async () => {
    const sqlMock = vi.fn()
      .mockRejectedValueOnce({ code: "40P01" })
      .mockRejectedValueOnce({ code: "40P01" });
    primeSql(sqlMock);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(
      acceptTradeOffer({
        twitchUserId: "viewer-1",
        tradeOfferId: TRADE_ID,
        requestId: REQUEST_ID,
      }),
    ).resolves.toEqual({ success: false, error: "TRADE_BUSY" });
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-deadlock database errors", async () => {
    const error = Object.assign(new Error("connection failed"), { code: "08006" });
    const sqlMock = vi.fn().mockRejectedValue(error);
    primeSql(sqlMock);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(
      acceptTradeOffer({
        twitchUserId: "viewer-1",
        tradeOfferId: TRADE_ID,
        requestId: REQUEST_ID,
      }),
    ).rejects.toBe(error);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("prechecks once before the first RPC attempt, not again on the 40P01 retry", async () => {
    const success = rpcSuccess({ idempotentReplay: true });
    const sqlMock = vi.fn()
      .mockRejectedValueOnce({ code: "40P01" })
      .mockResolvedValueOnce([{ result: success }]);
    const { db } = primeSql(sqlMock);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(acceptTradeOffer(ACCEPT_INPUT)).resolves.toEqual(success);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });
});

describe("acceptTradeOffer visibility / is_active precheck (#715 PR-C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  it.each([
    ["offered card hidden from the acceptor", { offeredVisible: false }],
    ["offered card inactive", { offeredActive: false, offeredVisible: false }],
    ["wanted card inactive", { wantedActive: false }],
    ["is_active NULL is treated as inactive", { offeredActive: null }],
  ])("rejects an open offer whose %s with TRADE_OFFER_UNAVAILABLE and never calls the RPC", async (_label, overrides) => {
    const sqlMock = vi.fn();
    primeSql(sqlMock, [
      [{ id: ACCEPTOR_ID, twitch_user_id: "viewer-1" }],
      [precheckRow(overrides)],
    ]);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(acceptTradeOffer(ACCEPT_INPUT)).resolves.toEqual({
      success: false,
      error: "TRADE_OFFER_UNAVAILABLE",
    });
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("skips validation for an idempotent replay even if the cards became inactive/hidden", async () => {
    const replay = rpcSuccess({ idempotentReplay: true });
    const sqlMock = vi.fn().mockResolvedValue([{ result: replay }]);
    primeSql(sqlMock, [
      [{ id: ACCEPTOR_ID, twitch_user_id: "viewer-1" }],
      [precheckRow({
        status: "completed",
        acceptedByUserId: ACCEPTOR_ID,
        acceptedRequestId: REQUEST_ID,
        offeredActive: false,
        wantedActive: false,
        offeredVisible: false,
      })],
    ]);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(acceptTradeOffer(ACCEPT_INPUT)).resolves.toEqual(replay);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["offer not found", [] as Array<Record<string, unknown>>],
    ["completed by someone else (RPC answers OFFER_NOT_OPEN)", [precheckRow({
      status: "completed",
      acceptedByUserId: OFFERER_ID,
      acceptedRequestId: REQUEST_ID,
      offeredVisible: false,
    })]],
    ["cancelled", [precheckRow({ status: "cancelled", offeredActive: false })]],
    ["self accept (RPC answers SELF_ACCEPT_FORBIDDEN)", [precheckRow({
      offererUserId: ACCEPTOR_ID,
      offeredActive: false,
    })]],
    ["deleted card definition (RPC cancels + OFFER_INVALID)", [precheckRow({
      offeredCardId: null,
      offeredActive: false,
      offeredVisible: false,
    })]],
  ])("delegates %s to the RPC unchanged", async (_label, offerRows) => {
    const rpcError = { success: false, error: "OFFER_NOT_OPEN" };
    const sqlMock = vi.fn().mockResolvedValue([{ result: rpcError }]);
    primeSql(sqlMock, [[{ id: ACCEPTOR_ID, twitch_user_id: "viewer-1" }], offerRows]);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(acceptTradeOffer(ACCEPT_INPUT)).resolves.toEqual(rpcError);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("delegates an unknown acceptor to the RPC (USER_NOT_FOUND contract) without reading the offer", async () => {
    const error = new Error("USER_NOT_FOUND");
    const sqlMock = vi.fn().mockRejectedValue(error);
    const { db } = primeSql(sqlMock, [[]]);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await expect(acceptTradeOffer(ACCEPT_INPUT)).rejects.toBe(error);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("evaluates active/visibility flags in SQL against the acceptor's users.id", async () => {
    const sqlMock = vi.fn().mockResolvedValue([{ result: rpcSuccess() }]);
    const { calls } = primeSql(sqlMock);

    const { acceptTradeOffer } = await import("@/lib/trade");
    await acceptTradeOffer(ACCEPT_INPUT);

    const fields = calls[1].fields as Record<string, SQL>;
    const dialect = new PgDialect();
    const visible = dialect.sqlToQuery(drizzleSql`${fields.offeredVisible}`);
    expect(visible.sql).toContain('visible_card.id = "trade_offers"."offered_card_id"');
    expect(visible.sql).toContain("visible_streamer.show_unowned_card_details = TRUE");
    expect(visible.sql).toContain("visible_owned.user_id = $1");
    expect(visible.params).toEqual([ACCEPTOR_ID]);
    const wantedActive = dialect.sqlToQuery(drizzleSql`${fields.wantedActive}`);
    expect(wantedActive.sql).toContain('active_card.id = "trade_offers"."wanted_card_id"');
    expect(wantedActive.sql).toContain("active_card.is_active = TRUE");
  });
});
