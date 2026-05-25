import { describe, it, expect, beforeEach, vi } from "vitest";
import { getGachaUsersForStreamer } from "@/lib/dashboard-data";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { reportError } from "@/lib/sentry/error-handler";

vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supabase/admin")>();
  return { ...actual, getSupabaseAdmin: vi.fn() };
});
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);
const mockReportError = vi.mocked(reportError);

const STREAMER_ID = "streamer-uuid-123";

/** RPC成功時のモッククライアントを作成 */
function createRpcSuccessClient(rpcData: unknown) {
  return {
    rpc: vi.fn().mockResolvedValue({ data: rpcData, error: null }),
    from: vi.fn(),
  };
}

/** RPCエラー時のモッククライアントを作成（フォールバック用のfromも設定） */
function createRpcErrorClient(
  errorCode: string,
  errorMessage: string,
  historyData: unknown[] | null = [],
  cardsData: unknown[] | null = []
) {
  // fromのチェーンメソッドをモック
  const historyQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: historyData, error: null }),
  };
  const cardsQuery = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: cardsData, error: null }),
    }),
  };

  return {
    rpc: vi.fn().mockResolvedValue({
      data: null,
      error: { code: errorCode, message: errorMessage },
    }),
    from: vi.fn((table: string) => {
      if (table === "gacha_history") return historyQuery;
      if (table === "cards") return cardsQuery;
      return historyQuery;
    }),
  };
}

describe("getGachaUsersForStreamer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("RPC成功時", () => {
    it("RPC結果をGachaUserEntry[]に正しく変換する", async () => {
      const rpcData = {
        users: [
          {
            user_twitch_id: "user1",
            username: "Alice",
            draw_count: 50,
            last_draw_at: "2025-01-01T00:00:00Z",
            unique_card_ids: ["card-a", "card-b"],
          },
          {
            user_twitch_id: "user2",
            username: "Bob",
            draw_count: 30,
            last_draw_at: "2025-01-02T00:00:00Z",
            unique_card_ids: ["card-a"],
          },
        ],
        total: 2,
      };
      mockGetSupabaseAdmin.mockReturnValue(
        createRpcSuccessClient(rpcData) as any
      );

      const result = await getGachaUsersForStreamer(STREAMER_ID, {
        page: 1,
        perPage: 20,
      });

      expect(result.users).toHaveLength(2);
      expect(result.users[0]).toEqual({
        userTwitchId: "user1",
        username: "Alice",
        drawCount: 50,
        uniqueCards: 2,
        uniqueCardIds: ["card-a", "card-b"],
        lastDrawAt: "2025-01-01T00:00:00Z",
      });
      expect(result.users[1]).toEqual({
        userTwitchId: "user2",
        username: "Bob",
        drawCount: 30,
        uniqueCards: 1,
        uniqueCardIds: ["card-a"],
        lastDrawAt: "2025-01-02T00:00:00Z",
      });
      expect(result.pagination).toEqual({
        page: 1,
        perPage: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it("RPCのunique_card_idsに重複があってもユニーク種数として扱う", async () => {
      const rpcData = {
        users: [
          {
            user_twitch_id: "user1",
            username: "Alice",
            draw_count: 1455,
            last_draw_at: "2026-05-13T05:00:00Z",
            unique_card_ids: ["card-a", "card-b", "card-a", "card-b", "card-c"],
          },
        ],
        total: 1,
      };
      mockGetSupabaseAdmin.mockReturnValue(
        createRpcSuccessClient(rpcData) as any
      );

      const result = await getGachaUsersForStreamer(STREAMER_ID);

      expect(result.users[0]).toMatchObject({
        drawCount: 1455,
        uniqueCards: 3,
        uniqueCardIds: ["card-a", "card-b", "card-c"],
      });
    });

    it("RPCにp_limit/p_offsetを正しく渡す", async () => {
      const rpcData = { users: [], total: 0 };
      const client = createRpcSuccessClient(rpcData);
      mockGetSupabaseAdmin.mockReturnValue(client as any);

      await getGachaUsersForStreamer(STREAMER_ID, { page: 3, perPage: 10 });

      expect(client.rpc).toHaveBeenCalledWith(
        "get_gacha_users_for_streamer",
        { p_streamer_id: STREAMER_ID, p_limit: 10, p_offset: 20 }
      );
    });

    it("ユーザーが0件の場合、空配列を返す", async () => {
      const rpcData = { users: [], total: 0 };
      mockGetSupabaseAdmin.mockReturnValue(
        createRpcSuccessClient(rpcData) as any
      );

      const result = await getGachaUsersForStreamer(STREAMER_ID);

      expect(result.users).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
    });

    it("usernameがnullの場合、空文字に変換する", async () => {
      const rpcData = {
        users: [
          {
            user_twitch_id: "user1",
            username: null,
            draw_count: 5,
            last_draw_at: "2025-01-01T00:00:00Z",
            unique_card_ids: [],
          },
        ],
        total: 1,
      };
      mockGetSupabaseAdmin.mockReturnValue(
        createRpcSuccessClient(rpcData) as any
      );

      const result = await getGachaUsersForStreamer(STREAMER_ID);

      expect(result.users[0].username).toBe("");
    });

    it("totalPagesが正しく切り上げ計算される", async () => {
      const rpcData = { users: [{ user_twitch_id: "u1", username: "A", draw_count: 1, last_draw_at: "2025-01-01T00:00:00Z", unique_card_ids: [] }], total: 21 };
      mockGetSupabaseAdmin.mockReturnValue(
        createRpcSuccessClient(rpcData) as any
      );

      const result = await getGachaUsersForStreamer(STREAMER_ID, { perPage: 10 });

      expect(result.pagination.totalPages).toBe(3);
    });

    it("RPC結果がnull（エラーなし）の場合、フォールバックする", async () => {
      // rpcResultがnullの場合はフォールバック（from経由のクエリが走る）
      const client = createRpcErrorClient("42883", "n/a", [], []);
      // rpcをnull返却に上書き
      client.rpc = vi.fn().mockResolvedValue({ data: null, error: null });
      mockGetSupabaseAdmin.mockReturnValue(client as any);

      const result = await getGachaUsersForStreamer(STREAMER_ID);

      // フォールバックで空結果
      expect(result.users).toEqual([]);
    });
  });

  describe("RPC未デプロイ時（42883エラー）のフォールバック", () => {
    it("クライアント側集約にフォールバックする", async () => {
      const historyData = [
        {
          user_twitch_id: "user1",
          user_twitch_username: "Alice",
          card_id: "card-a",
          redeemed_at: "2025-01-01T00:00:00Z",
        },
        {
          user_twitch_id: "user1",
          user_twitch_username: "Alice",
          card_id: "card-b",
          redeemed_at: "2025-01-02T00:00:00Z",
        },
      ];
      const cardsData = [{ id: "card-a" }, { id: "card-b" }];

      mockGetSupabaseAdmin.mockReturnValue(
        createRpcErrorClient(
          "42883",
          "function not found",
          historyData,
          cardsData
        ) as any
      );

      const result = await getGachaUsersForStreamer(STREAMER_ID);

      expect(result.users).toHaveLength(1);
      expect(result.users[0].userTwitchId).toBe("user1");
      expect(result.users[0].drawCount).toBe(2);
      expect(result.users[0].uniqueCardIds).toEqual(
        expect.arrayContaining(["card-a", "card-b"])
      );
      // reportErrorは42883では呼ばれない
      expect(mockReportError).not.toHaveBeenCalled();
    });
  });

  describe("RPCその他エラー時のフォールバック", () => {
    it("reportErrorを呼びつつフォールバックする", async () => {
      mockGetSupabaseAdmin.mockReturnValue(
        createRpcErrorClient("PGRST202", "some db error", [], []) as any
      );

      const result = await getGachaUsersForStreamer(STREAMER_ID);

      // フォールバックで空結果（履歴データなし）
      expect(result.users).toEqual([]);
      // reportErrorが呼ばれている
      expect(mockReportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "get_gacha_users_for_streamer RPC failed"
          ),
        })
      );
    });
  });
});
