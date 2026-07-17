import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  isMissingCollectionNameColumn,
  isMissingDefaultCardPackNameColumnError,
  isMissingRenameCardPackFunctionError,
  checkCollectionHasActiveCards,
} from "@/lib/collections/collection-existence";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import { createMockQueryBuilder } from "../../utils/supabase-mock";
import { getDb } from "@/lib/db/client";
import { cards as cardsTable } from "@/lib/db/schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

describe("isMissingCollectionNameColumn", () => {
  it("detects the WRITE shape (PGRST204 schema-cache miss)", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "PGRST204",
        message: "Could not find the 'collection_name' column of 'cards' in the schema cache",
      })
    ).toBe(true);
  });

  it("detects the READ shape (42703 'does not exist') — the deploy-window SELECT case", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "42703",
        message: "column cards.collection_name does not exist",
      })
    ).toBe(true);
  });

  it("detects channel_point_collection_name too (substring match)", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "42703",
        message: "column streamers.channel_point_collection_name does not exist",
      })
    ).toBe(true);
  });

  it("does NOT match raid-option schema errors (no false positive)", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "PGRST204",
        message: "Could not find the 'draw_count' column",
      })
    ).toBe(false);
    expect(
      isMissingCollectionNameColumn({
        code: "42703",
        message: "column streamer_additional_gacha_rewards.is_raid_limited does not exist",
      })
    ).toBe(false);
  });

  it("does NOT match unrelated columns even on a bare PGRST204", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "PGRST204",
        message: "Could not find the 'some_other_column' column",
      })
    ).toBe(false);
  });

  it("does NOT match a NOT NULL constraint violation on collection_name (future-proofing)", () => {
    // 23502 mentions both "collection_name" and "column" but is a real write
    // failure, not a missing column — it must not be swallowed as schema-not-ready.
    expect(
      isMissingCollectionNameColumn({
        code: "23502",
        message:
          "null value in column \"collection_name\" of relation \"cards\" violates not-null constraint",
      })
    ).toBe(false);
  });

  it("returns false for null/empty errors", () => {
    expect(isMissingCollectionNameColumn(null)).toBe(false);
    expect(isMissingCollectionNameColumn(undefined)).toBe(false);
    expect(isMissingCollectionNameColumn({})).toBe(false);
  });

  // 2026-07 本番障害の回帰テスト: checkCollectionHasActiveCardsPg /
  // getStreamerForSettingsUpdate (streamer/settings/route.ts) は pg 直結の
  // Drizzle エラーをそのまま isMissingCollectionNameColumn 等に渡す。Drizzle は
  // postgres.js のエラーを `{ query, params, cause }` で1段ラップするため、
  // トップレベルの code/message だけを見ていると pg 経路でこのフォールバックが
  // 機能しない（cards-safe-columns.ts / card-number-errors.ts と同じ原因）。
  it("detects the READ shape (42703) even when wrapped by Drizzle ({ query, params, cause })", () => {
    const wrapped = {
      query: 'select "collection_name" from "cards" where ...',
      params: [],
      cause: { code: "42703", message: "column cards.collection_name does not exist" },
    };
    expect(isMissingCollectionNameColumn(wrapped)).toBe(true);
  });

  it("does NOT match raid-option errors even when wrapped (no false positive)", () => {
    const wrapped = {
      query: 'select "draw_count" from "streamer_additional_gacha_rewards" where ...',
      params: [],
      cause: { code: "PGRST204", message: "Could not find the 'draw_count' column" },
    };
    expect(isMissingCollectionNameColumn(wrapped)).toBe(false);
  });

  // 2026-07 Fable厳格レビュー指摘(中4)の回帰テスト。レビュアーが実測で確認した
  // 過検知シナリオそのものの再現: 「全階層のテキストを連結してから判定する」
  // 実装だと、cause は無関係な列（max_issuance_count）の 42703 なのに、
  // ラッパー層の SELECT 文が (パフォーマンスのため) collection_name も一緒に
  // 選択しているだけで isMissingCollectionNameColumn が true を返してしまい、
  // 誤って「パック機能が使えません」というユーザー向けエラーになっていた。
  // 各階層を独立に判定することで防ぐ。
  it("cause=42703(max_issuance_count) でも、ラッパーSELECT文にcollection_nameが含まれるだけならfalse", () => {
    const wrapped = {
      message:
        'Failed query: select "id", "collection_name", "max_issuance_count", "name" from "cards" where ...',
      query: 'select "id", "collection_name", "max_issuance_count", "name" from "cards" where ...',
      params: [],
      cause: {
        code: "42703",
        message: 'column "max_issuance_count" of relation "cards" does not exist',
      },
    };
    expect(isMissingCollectionNameColumn(wrapped)).toBe(false);
  });
});

// Issue #554: `streamers.default_card_pack_name` deploy-window detection.
describe("isMissingDefaultCardPackNameColumnError", () => {
  it("detects the WRITE shape (PGRST204)", () => {
    expect(
      isMissingDefaultCardPackNameColumnError({
        code: "PGRST204",
        message: "Could not find the 'default_card_pack_name' column of 'streamers' in the schema cache",
      })
    ).toBe(true);
  });

  it("detects the READ shape (42703)", () => {
    expect(
      isMissingDefaultCardPackNameColumnError({
        code: "42703",
        message: "column streamers.default_card_pack_name does not exist",
      })
    ).toBe(true);
  });

  it("does not match unrelated columns", () => {
    expect(
      isMissingDefaultCardPackNameColumnError({
        code: "PGRST204",
        message: "Could not find the 'card_pack_names' column",
      })
    ).toBe(false);
  });

  it("returns false for null/empty errors", () => {
    expect(isMissingDefaultCardPackNameColumnError(null)).toBe(false);
    expect(isMissingDefaultCardPackNameColumnError(undefined)).toBe(false);
    expect(isMissingDefaultCardPackNameColumnError({})).toBe(false);
  });
});

// Issue #554: `rename_card_pack` RPC deploy-window detection (missing FUNCTION,
// not a missing column — different Postgres error shape: 42883).
describe("isMissingRenameCardPackFunctionError", () => {
  it("detects the undefined_function error (42883) mentioning rename_card_pack", () => {
    expect(
      isMissingRenameCardPackFunctionError({
        code: "42883",
        message: "function rename_card_pack(uuid, text, text) does not exist",
      })
    ).toBe(true);
  });

  it("does not match a 42883 error for an unrelated function", () => {
    expect(
      isMissingRenameCardPackFunctionError({
        code: "42883",
        message: "function some_other_function(uuid) does not exist",
      })
    ).toBe(false);
  });

  it("does not match a differently-coded error even if it mentions rename_card_pack", () => {
    expect(
      isMissingRenameCardPackFunctionError({
        code: "P0001",
        message: "rename_card_pack: OLD_NAME_NOT_FOUND",
      })
    ).toBe(false);
  });

  it("returns false for null/empty errors", () => {
    expect(isMissingRenameCardPackFunctionError(null)).toBe(false);
    expect(isMissingRenameCardPackFunctionError(undefined)).toBe(false);
    expect(isMissingRenameCardPackFunctionError({})).toBe(false);
  });

  // 2026-07 本番障害の回帰テスト（詳細は isMissingCollectionNameColumn の同種テスト参照）
  it("detects the error even when wrapped by Drizzle ({ query, params, cause })", () => {
    const wrapped = {
      query: "select rename_card_pack(...)",
      params: [],
      cause: { code: "42883", message: "function rename_card_pack(uuid, text, text) does not exist" },
    };
    expect(isMissingRenameCardPackFunctionError(wrapped)).toBe(true);
  });
});

// Issue #555: DEFAULT_PACK_SENTINEL asks about the DEFAULT (unclassified) pack
// — collection_name IS NULL — the inverse of the normal named-pack `.eq(...)`
// lookup. Fixes the query shape used by checkCollectionHasActiveCards.
describe("checkCollectionHasActiveCards", () => {
  function buildCardsQuery(count: number | null, error: unknown = null) {
    const q = createMockQueryBuilder();
    (q as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ count, error });
      return q;
    };
    return q;
  }

  it("queries a normal pack name via .eq('collection_name', name)", async () => {
    const cardsQuery = buildCardsQuery(3);
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    const result = await checkCollectionHasActiveCards(supabase, "streamer-1", "weapons");

    expect(result).toBe("exists");
    expect(cardsQuery.eq).toHaveBeenCalledWith("collection_name", "weapons");
    expect(cardsQuery.is).not.toHaveBeenCalled();
  });

  it("queries DEFAULT_PACK_SENTINEL via .is('collection_name', null), NOT .eq", async () => {
    const cardsQuery = buildCardsQuery(2);
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    const result = await checkCollectionHasActiveCards(supabase, "streamer-1", DEFAULT_PACK_SENTINEL);

    expect(result).toBe("exists");
    expect(cardsQuery.is).toHaveBeenCalledWith("collection_name", null);
    // A literal .eq('collection_name', '__default__') would never match any real
    // card, so it must not be used for the sentinel.
    expect(cardsQuery.eq).not.toHaveBeenCalledWith("collection_name", DEFAULT_PACK_SENTINEL);
  });

  it("returns 'absent' when the default pack has zero active (unclassified) cards", async () => {
    const cardsQuery = buildCardsQuery(0);
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    const result = await checkCollectionHasActiveCards(supabase, "streamer-1", DEFAULT_PACK_SENTINEL);
    expect(result).toBe("absent");
  });

  it("returns 'schema-not-ready' for the deploy-window column error even when checking the sentinel", async () => {
    const cardsQuery = buildCardsQuery(null, {
      code: "42703",
      message: "column cards.collection_name does not exist",
    });
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    const result = await checkCollectionHasActiveCards(supabase, "streamer-1", DEFAULT_PACK_SENTINEL);
    expect(result).toBe("schema-not-ready");
  });
});

// #663: pg 直結経路（postgrest 経路との形状互換）
describe("checkCollectionHasActiveCards: postgrest / pg 経路の互換 (#663)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createDrizzleDbMock(config: { rowCount?: number; error?: unknown }) {
    const calls: Array<{ whereCondition?: unknown }> = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          const call: { whereCondition?: unknown } = {};
          calls.push(call);
          const builder: any = {
            where: vi.fn((condition: unknown) => {
              call.whereCondition = condition;
              return builder;
            }),
            then: (onFulfilled: any, onRejected: any) =>
              (config.error
                ? Promise.reject(config.error)
                : Promise.resolve([{ count: config.rowCount ?? 0 }])
              ).then(onFulfilled, onRejected),
          };
          return builder;
        }),
      })),
    };
    return { db, calls };
  }

  it("通常のパック名: 両経路とも exists/absent が一致する", async () => {
    const cardsQuery = createMockQueryBuilder();
    (cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ count: 3, error: null });
      return cardsQuery;
    };
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    vi.stubEnv("DB_DRIVER", undefined);
    const postgrestResult = await checkCollectionHasActiveCards(supabase, "streamer-1", "weapons");

    vi.stubEnv("DB_DRIVER", "pg-read");
    const pg = createDrizzleDbMock({ rowCount: 3 });
    vi.mocked(getDb).mockResolvedValue({ db: pg.db, sql: {} } as any);
    const pgResult = await checkCollectionHasActiveCards(supabase, "streamer-1", "weapons");

    expect(pgResult).toEqual(postgrestResult);
    expect(pgResult).toBe("exists");
    expect(pg.calls[0].whereCondition).toEqual(
      and(
        eq(cardsTable.streamer_id, "streamer-1"),
        eq(cardsTable.is_active, true),
        eq(cardsTable.collection_name, "weapons")
      )
    );
  });

  it("DEFAULT_PACK_SENTINEL: pg 経路は isNull(collection_name) で判定し absent を返す", async () => {
    const supabase = { from: vi.fn() } as unknown as SupabaseClient<Database>;

    vi.stubEnv("DB_DRIVER", "pg-read");
    const pg = createDrizzleDbMock({ rowCount: 0 });
    vi.mocked(getDb).mockResolvedValue({ db: pg.db, sql: {} } as any);
    const pgResult = await checkCollectionHasActiveCards(supabase, "streamer-1", DEFAULT_PACK_SENTINEL);

    expect(pgResult).toBe("absent");
    expect(pg.calls[0].whereCondition).toEqual(
      and(
        eq(cardsTable.streamer_id, "streamer-1"),
        eq(cardsTable.is_active, true),
        isNull(cardsTable.collection_name)
      )
    );
  });

  it("pg 経路で列未デプロイエラー(42703)時は schema-not-ready を返す", async () => {
    const supabase = { from: vi.fn() } as unknown as SupabaseClient<Database>;

    vi.stubEnv("DB_DRIVER", "pg-read");
    const pg = createDrizzleDbMock({
      error: { code: "42703", message: "column cards.collection_name does not exist" },
    });
    vi.mocked(getDb).mockResolvedValue({ db: pg.db, sql: {} } as any);

    const result = await checkCollectionHasActiveCards(supabase, "streamer-1", "weapons");
    expect(result).toBe("schema-not-ready");
  });

  it("pg 経路で想定外のエラーは throw する", async () => {
    const supabase = { from: vi.fn() } as unknown as SupabaseClient<Database>;

    vi.stubEnv("DB_DRIVER", "pg-read");
    const pg = createDrizzleDbMock({ error: { code: "08006", message: "connection failure" } });
    vi.mocked(getDb).mockResolvedValue({ db: pg.db, sql: {} } as any);

    await expect(checkCollectionHasActiveCards(supabase, "streamer-1", "weapons")).rejects.toBeTruthy();
  });

  it("postgrest 経路（フラグ未設定）では getDb が一切呼ばれない", async () => {
    const cardsQuery = createMockQueryBuilder();
    (cardsQuery as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ count: 1, error: null });
      return cardsQuery;
    };
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    vi.stubEnv("DB_DRIVER", undefined);
    await checkCollectionHasActiveCards(supabase, "streamer-1", "weapons");
    expect(getDb).not.toHaveBeenCalled();
  });
});
