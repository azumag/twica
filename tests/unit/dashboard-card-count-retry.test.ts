import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { reportError } from "@/lib/sentry/error-handler";
import { getUserCards, getUserCardsForStreamer } from "@/lib/dashboard-data";

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("@/lib/card-utils", () => ({
  normalizeDropRate: (cards: unknown[]) => cards,
}));

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);
const mockReportError = vi.mocked(reportError);

const rpcCardRow = {
  count: 2,
  card: {
    id: "card-1",
    streamer_id: "streamer-1",
    name: "Rare Card",
    rarity: "rare",
    image_url: "https://example.com/card.png",
    drop_rate: 10,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
  streamer: {
    id: "streamer-1",
    twitch_user_id: "streamer-twitch-1",
    username: "streamer",
    display_name: "Streamer",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
};

describe("dashboard card count RPC retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries transient get_user_card_counts failures before returning all user cards", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: "502", message: "error code: 502" },
        status: 502,
      })
      .mockResolvedValueOnce({
        data: [rpcCardRow],
        error: null,
        status: 200,
      });
    mockGetSupabaseAdmin.mockReturnValue({ rpc } as any);

    const result = await getUserCards("viewer-1");

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "get_user_card_counts", {
      p_twitch_user_id: "viewer-1",
    });
    expect(result).toEqual([
      {
        ...rpcCardRow.card,
        streamer: rpcCardRow.streamer,
        count: 2,
      },
    ]);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("retries transient get_user_card_counts failures before returning streamer-specific cards", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: "502", message: "Bad Gateway" },
        status: 502,
      })
      .mockResolvedValueOnce({
        data: [rpcCardRow],
        error: null,
        status: 200,
      });
    mockGetSupabaseAdmin.mockReturnValue({ rpc } as any);

    const result = await getUserCardsForStreamer("viewer-1", "streamer-1");

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "get_user_card_counts", {
      p_twitch_user_id: "viewer-1",
      p_streamer_id: "streamer-1",
    });
    expect(result).toEqual([
      {
        ...rpcCardRow.card,
        streamer: rpcCardRow.streamer,
        count: 2,
      },
    ]);
    expect(mockReportError).not.toHaveBeenCalled();
  });
});
