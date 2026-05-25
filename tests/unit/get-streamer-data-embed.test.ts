import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getStreamerData } from "@/lib/dashboard-data";

vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("@/lib/card-utils", () => ({
  normalizeDropRate: (cards: unknown[]) => cards,
}));

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin);

describe("getStreamerData streamers->cards embed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression guard for PGRST201: migration 00051 added card_owner_stats which
  // references both streamers and cards, making an un-hinted `cards (*)` embed
  // ambiguous. The query must pin the relationship to the cards.streamer_id FK
  // so card management / settings pages keep loading for affiliates/partners.
  it("disambiguates the cards embed via the streamer_id foreign key constraint", async () => {
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: { id: "s-1", cards: [] }, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    mockGetSupabaseAdmin.mockReturnValue({ from } as never);

    await getStreamerData("twitch-1");

    expect(from).toHaveBeenCalledWith("streamers");
    const selectArg = select.mock.calls[0][0] as string;
    expect(selectArg).toContain("cards!cards_streamer_id_fkey (*)");
    expect(selectArg).not.toMatch(/(^|\s)cards \(\*\)/);
  });
});
