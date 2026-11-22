import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db/client";

/**
 * #2070: 画像レベルの可視性マスク（maskTradeCardImages）。
 *
 * 名前は見せてよいが画像は見せない、という状態は行の EXISTS だけでは表せない。
 * サービス層は snapshot を保存したまま読み出し時に imageUrl だけを落とすので、
 * その共通関数の deny-by-default な性質をここで固定する。
 *
 * SQL（所持 OR 詳細公開、is_active を問わない）が実際に正しい行を返すことは
 * tests/integration/trade-visibility-pg.test.ts の NAMEONLY fixture が実 PostgreSQL で
 * 確かめる。このファイルはマスク関数の入出力だけをモックで検証する。
 */
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const CARD_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CARD_ID = "22222222-2222-4222-8222-222222222222";
const VIEWER_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "https://secret.example/unowned-card.png";

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  name: "Secret Card",
  rarity: "legendary",
  imageUrl: SECRET,
  ...overrides,
});

/** DB double whose single SELECT returns `rows` (the visible card-id set). */
function primeMask(rows: unknown[]) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(rows)),
    })),
  }));
  vi.mocked(getDb).mockResolvedValue({ db: { select }, sql: {} } as never);
  return { select };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("maskTradeCardImages (#2070)", () => {
  it.each([
    ["the viewer owns the card", [{ cardId: CARD_ID }]],
    ["the card's streamer reveals details", [{ cardId: CARD_ID }]],
    ["neither (name-only channel)", []],
  ])("keeps the image only when the viewer may see it: %s", async (_label, visibleRows) => {
    primeMask(visibleRows as unknown[]);
    const { maskTradeCardImages } = await import("@/lib/trade");

    const [masked] = await maskTradeCardImages(
      [{ cardId: CARD_ID, snapshot: snapshot() }],
      VIEWER_ID,
    );

    if (visibleRows.length > 0) {
      expect(masked.imageUrl).toBe(SECRET);
    } else {
      expect(masked.imageUrl).toBeNull();
    }
  });

  it.each([
    ["an empty result set", []],
    ["a null card id row", [{ cardId: null }]],
    ["a row without a card id", [{}]],
  ])("deny-by-default: %s masks every image", async (_label, rows) => {
    primeMask(rows as unknown[]);
    const { maskTradeCardImages } = await import("@/lib/trade");

    const [masked] = await maskTradeCardImages(
      [{ cardId: CARD_ID, snapshot: snapshot() }],
      VIEWER_ID,
    );

    expect(masked.imageUrl).toBeNull();
  });

  it("keeps name, rarity and every other field, and never mutates the input DTO", async () => {
    primeMask([]);
    const { maskTradeCardImages } = await import("@/lib/trade");
    const input = snapshot({ description: "kept as-is by the caller", quantity: 2 });

    const [masked] = await maskTradeCardImages([{ cardId: CARD_ID, snapshot: input }], VIEWER_ID);

    expect(masked).toEqual({
      name: "Secret Card",
      rarity: "legendary",
      imageUrl: null,
      description: "kept as-is by the caller",
      quantity: 2,
    });
    expect(input.imageUrl).toBe(SECRET);
    expect(masked).not.toBe(input);
  });

  it("masks an image whose card id is unknown (cannot be proven visible)", async () => {
    const { select } = primeMask([{ cardId: CARD_ID }]);
    const { maskTradeCardImages } = await import("@/lib/trade");

    const [masked] = await maskTradeCardImages([{ cardId: null, snapshot: snapshot() }], VIEWER_ID);

    expect(masked.imageUrl).toBeNull();
    // Nothing to look up: a NULL card id cannot be in the visible set.
    expect(select).not.toHaveBeenCalled();
  });

  it("skips the query when every snapshot already has imageUrl: null", async () => {
    const { select } = primeMask([{ cardId: CARD_ID }]);
    const { maskTradeCardImages } = await import("@/lib/trade");

    const result = await maskTradeCardImages(
      [{ cardId: CARD_ID, snapshot: snapshot({ imageUrl: null }) }],
      VIEWER_ID,
    );

    expect(result).toEqual([{ name: "Secret Card", rarity: "legendary", imageUrl: null }]);
    expect(select).not.toHaveBeenCalled();
  });

  it("returns an empty array for an empty input without querying", async () => {
    const { select } = primeMask([{ cardId: CARD_ID }]);
    const { maskTradeCardImages } = await import("@/lib/trade");

    await expect(maskTradeCardImages([], VIEWER_ID)).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it("batches every target card id into one query and masks per card", async () => {
    const { select } = primeMask([{ cardId: CARD_ID }]);
    const { maskTradeCardImages } = await import("@/lib/trade");

    const masked = await maskTradeCardImages(
      [
        { cardId: CARD_ID, snapshot: snapshot() },
        { cardId: OTHER_CARD_ID, snapshot: snapshot({ name: "Other" }) },
      ],
      null,
    );

    expect(select).toHaveBeenCalledTimes(1);
    expect(masked[0].imageUrl).toBe(SECRET);
    expect(masked[1].imageUrl).toBeNull();
    expect(masked[1].name).toBe("Other");
  });
});
