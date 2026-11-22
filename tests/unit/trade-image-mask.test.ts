import { beforeEach, describe, expect, it, vi } from "vitest";

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";

/**
 * 未所持カードの項目別可視性マスク（maskTradeCards）。
 *
 * トレードの snapshot は保存時に完全なまま保存し、読み取り時に
 *   * 名前: 所持 ≥ 1 OR 解決済み name 公開
 *   * 画像: 所持 ≥ 1 OR 解決済み image 公開
 *   * 表示番号: その配信者の全カード（無効化含む）から作る閲覧者非依存の #N
 * を適用する。ここでは DB をモックして入出力の契約だけを固定する。
 *
 * どの card id が可視になるか（相関 EXISTS / 規則 a〜d / ガード c / デプロイ窓）
 * は tests/integration/trade-visibility-pg.test.ts が実 PostgreSQL で確かめる。
 * このファイルは「(nameVisible, imageVisible) の組み合わせ → DTO」と
 * 「deny-by-default」「番号表の入力」を固定する。
 */
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db/retry", () => ({
  withDbRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const CARD_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CARD_ID = "22222222-2222-4222-8222-222222222222";
const STREAMER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_STREAMER_ID = "44444444-4444-4444-8444-444444444444";
const VIEWER_ID = "55555555-5555-4555-8555-555555555555";
const SECRET = "https://secret.example/unowned-card.png";

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  name: "Secret Card",
  rarity: "legendary",
  imageUrl: SECRET,
  collectionNumber: null,
  ...overrides,
});

type MaskRow = {
  cardId: string;
  streamerId: string;
  nameVisible: boolean;
  imageVisible: boolean;
};
type NumberRow = {
  id: string;
  streamerId: string;
  cardNumber: number | null;
  createdAt: string;
};

function selectBuilder(rows: unknown[] | Error) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() =>
        rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
      ),
    })),
  };
}

/**
 * db.select の1回目（可視性）と2回目（番号表）を順に返すモック。
 * 呼び出し回数と、渡された fields を検査できるようにする。
 */
function primeMask(
  maskRows: MaskRow[] | Error,
  numberRows: NumberRow[] = [],
) {
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  const select = vi.fn((fields: Record<string, unknown>) => {
    calls.push(fields);
    const step = index++ === 0 ? maskRows : numberRows;
    return selectBuilder(step);
  });
  vi.mocked(getDb).mockResolvedValue({ db: { select }, sql: {} } as never);
  return { select, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("maskTradeCards: 項目別の名前・画像マスク", () => {
  it.each([
    ["全公開", true, true],
    ["名前だけ非公開", false, true],
    ["画像だけ非公開（名前だけ公開）", true, false],
    ["全非公開", false, false],
  ])("%s の組み合わせをそのまま適用する", async (_label, nameVisible, imageVisible) => {
    primeMask(
      [{ cardId: CARD_ID, streamerId: STREAMER_ID, nameVisible, imageVisible }],
      [{ id: CARD_ID, streamerId: STREAMER_ID, cardNumber: 1, createdAt: "2026-01-01T00:00:00Z" }],
    );
    const { maskTradeCards } = await import("@/lib/trade");

    const [masked] = await maskTradeCards(
      [{ cardId: CARD_ID, snapshot: snapshot() }],
      VIEWER_ID,
    );

    expect(masked.name).toBe(nameVisible ? "Secret Card" : "");
    expect(masked.imageUrl).toBe(imageVisible ? SECRET : null);
    // 番号は可視性と独立して常に付く（名前が隠れていても #N で選べる）。
    expect(masked.collectionNumber).toBe(1);
    expect(masked.rarity).toBe("legendary");
  });

  it("所持は SQL 側の nameVisible/imageVisible に含まれる（マスクは結果をそのまま使う）", async () => {
    primeMask([{ cardId: CARD_ID, streamerId: STREAMER_ID, nameVisible: true, imageVisible: true }]);
    const { maskTradeCards } = await import("@/lib/trade");

    const [masked] = await maskTradeCards(
      [{ cardId: CARD_ID, snapshot: snapshot() }],
      VIEWER_ID,
    );

    expect(masked.name).toBe("Secret Card");
    expect(masked.imageUrl).toBe(SECRET);
  });

  it("deny-by-default: 可視性クエリに現れないカードは名前・画像・番号とも空/null", async () => {
    primeMask([]);
    const { maskTradeCards } = await import("@/lib/trade");

    const [masked] = await maskTradeCards(
      [{ cardId: CARD_ID, snapshot: snapshot() }],
      VIEWER_ID,
    );

    expect(masked).toEqual({
      name: "",
      rarity: "legendary",
      imageUrl: null,
      collectionNumber: null,
    });
  });

  it("カードIDが NULL（削除済み定義・不明）なら問い合わせずに全項目を落とす", async () => {
    const { select } = primeMask([]);
    const { maskTradeCards } = await import("@/lib/trade");

    const [masked] = await maskTradeCards([{ cardId: null, snapshot: snapshot() }], VIEWER_ID);

    expect(masked).toEqual({
      name: "",
      rarity: "legendary",
      imageUrl: null,
      collectionNumber: null,
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("入力スナップショットを変更せず、新しいオブジェクトを返す", async () => {
    primeMask([{ cardId: CARD_ID, streamerId: STREAMER_ID, nameVisible: false, imageVisible: false }]);
    const { maskTradeCards } = await import("@/lib/trade");
    const input = snapshot();

    const [masked] = await maskTradeCards([{ cardId: CARD_ID, snapshot: input }], VIEWER_ID);

    expect(input).toEqual(snapshot());
    expect(masked).not.toBe(input);
  });

  it("空配列はクエリなしで空配列を返す", async () => {
    const { select } = primeMask([]);
    const { maskTradeCards } = await import("@/lib/trade");

    await expect(maskTradeCards([], VIEWER_ID)).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});

describe("maskTradeCards: 表示番号（#N）", () => {
  it("閲覧者に依存しない: 同じ card id は同じ番号になり、入力の順序に影響されない", async () => {
    // 配信者の全カード。無効化カード（is_active=false）も番号表の入力に含まれる
    // ことを、card_number 未設定のカードを created_at 順で採番して確かめる。
    const numberRows: NumberRow[] = [
      { id: "aaaaaaaa-0000-4000-8000-000000000001", streamerId: STREAMER_ID, cardNumber: null, createdAt: "2025-01-01T00:00:00Z" },
      { id: CARD_ID, streamerId: STREAMER_ID, cardNumber: null, createdAt: "2025-02-01T00:00:00Z" },
    ];
    primeMask(
      [
        { cardId: OTHER_CARD_ID, streamerId: STREAMER_ID, nameVisible: false, imageVisible: false },
        { cardId: CARD_ID, streamerId: STREAMER_ID, nameVisible: false, imageVisible: false },
      ],
      numberRows,
    );
    const { maskTradeCards } = await import("@/lib/trade");

    const masked = await maskTradeCards(
      [
        { cardId: CARD_ID, snapshot: snapshot() },
        { cardId: OTHER_CARD_ID, snapshot: snapshot({ name: "Other" }) },
      ],
      VIEWER_ID,
    );

    // 既存カード（2025-01-01）が #1、CARD_ID が #2。OTHER_CARD_ID は番号表に
    // 存在しないので null（deny-by-default）だが、CARD_ID の番号は変わらない。
    expect(masked[0].collectionNumber).toBe(2);
    expect(masked[1].collectionNumber).toBeNull();
  });

  it("複数配信者でも1つの番号表クエリにまとめ、配信者ごとに採番する", async () => {
    const otherNumberCard = "bbbbbbbb-0000-4000-8000-000000000001";
    const { select } = primeMask(
      [
        { cardId: CARD_ID, streamerId: STREAMER_ID, nameVisible: true, imageVisible: true },
        { cardId: OTHER_CARD_ID, streamerId: OTHER_STREAMER_ID, nameVisible: true, imageVisible: true },
      ],
      [
        { id: CARD_ID, streamerId: STREAMER_ID, cardNumber: 3, createdAt: "2025-01-01T00:00:00Z" },
        { id: otherNumberCard, streamerId: OTHER_STREAMER_ID, cardNumber: null, createdAt: "2025-01-01T00:00:00Z" },
        { id: OTHER_CARD_ID, streamerId: OTHER_STREAMER_ID, cardNumber: null, createdAt: "2025-02-01T00:00:00Z" },
      ],
    );
    const { maskTradeCards } = await import("@/lib/trade");

    const masked = await maskTradeCards(
      [
        { cardId: CARD_ID, snapshot: snapshot() },
        { cardId: OTHER_CARD_ID, snapshot: snapshot() },
      ],
      VIEWER_ID,
    );

    expect(select).toHaveBeenCalledTimes(2); // 可視性 + 番号表（配信者数に依存しない）
    expect(masked[0].collectionNumber).toBe(3);
    expect(masked[1].collectionNumber).toBe(2);
  });
});

describe("maskTradeCards: デプロイ窓（新3列の欠落）", () => {
  it("42703 を検知して旧 details だけの SQL で1回だけ再試行する", async () => {
    const missing = Object.assign(
      new Error("column name_streamer.show_unowned_card_name does not exist"),
      { code: "42703" },
    );
    const calls: Array<Record<string, unknown>> = [];
    let index = 0;
    const select = vi.fn((fields: Record<string, unknown>) => {
      calls.push(fields);
      return selectBuilder(index++ === 0 ? missing : []);
    });
    vi.mocked(getDb).mockResolvedValue({ db: { select }, sql: {} } as never);

    const { maskTradeCards } = await import("@/lib/trade");
    await maskTradeCards([{ cardId: CARD_ID, snapshot: snapshot() }], VIEWER_ID);

    const dialect = new PgDialect();
    const first = dialect.sqlToQuery(
      drizzleSql`${(calls[0] as Record<string, SQL>).nameVisible}`,
    ).sql;
    const retry = dialect.sqlToQuery(
      drizzleSql`${(calls[1] as Record<string, SQL>).nameVisible}`,
    ).sql;
    // 通常時は新3列（とガード c）を参照する。
    expect(first).toContain("show_unowned_card_name");
    expect(first).toContain("show_unowned_card_image");
    expect(first).toContain("show_unowned_card_description");
    // 再試行は旧 details のみ。新3列を一切参照しない。
    expect(retry).toContain("show_unowned_card_details");
    expect(retry).not.toContain("show_unowned_card_name");
    expect(retry).not.toContain("show_unowned_card_image");
    expect(retry).not.toContain("show_unowned_card_description");
  });
});

describe("maskTradeCardImages: オークション用の互換ラッパー", () => {
  it("実体は maskTradeCards と同じ（名前・画像・番号をまとめてマスクする）", async () => {
    primeMask([{
      cardId: CARD_ID,
      streamerId: STREAMER_ID,
      nameVisible: false,
      imageVisible: false,
    }]);
    const { maskTradeCardImages } = await import("@/lib/trade");

    const [masked] = await maskTradeCardImages(
      [{ cardId: CARD_ID, snapshot: snapshot() }],
      VIEWER_ID,
    );

    // 名前を素通しすると、行ルール変更後のオークションが名前の
    // side channel になる。互換ラッパーでも名前はマスクする。
    expect(masked.name).toBe("");
    expect(masked.imageUrl).toBeNull();
  });
});
