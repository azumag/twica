import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db/client";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

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

function primeSql(sqlMock: ReturnType<typeof vi.fn>) {
  vi.mocked(getDb).mockResolvedValue({ db: {}, sql: sqlMock } as never);
}

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
    [{ success: true }, "missing success fields"],
    [rpcSuccess({ tradeOfferId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), "mismatched trade offer"],
    [rpcSuccess({ receivedUserCardId: "not-a-uuid" }), "invalid received card id"],
    [rpcSuccess({ completedAt: "not-a-date" }), "invalid completion timestamp"],
    [rpcSuccess({ idempotentReplay: "false" }), "invalid replay flag"],
    [{ success: false, error: "FUTURE_UNKNOWN_ERROR" }, "unknown failure code"],
  ])("fails closed on %s RPC payload", async (result) => {
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
});
