import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/streamer/[streamerId]/sound-settings/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

vi.mock("@/lib/supabase/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
  return {
    ...actual,
    getSupabaseAdmin: vi.fn(),
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function createSoundSettingsClient(response: {
  data: { gacha_sound_url: string | null; gacha_sound_enabled: boolean | null } | null;
  error: { message: string; code?: string } | null;
  status?: number;
}) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(response),
  };

  return {
    from: vi.fn(() => query),
    query,
  };
}

function request() {
  return new NextRequest("http://localhost:3000/api/streamer/streamer-1/sound-settings");
}

describe("GET /api/streamer/[streamerId]/sound-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the configured sound settings", async () => {
    const mockSupabase = createSoundSettingsClient({
      data: {
        gacha_sound_url: "https://cdn.example.com/sound.mp3",
        gacha_sound_enabled: true,
      },
      error: null,
      status: 200,
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>);

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: "streamer-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      soundUrl: "https://cdn.example.com/sound.mp3",
      soundEnabled: true,
    });
    expect(mockSupabase.from).toHaveBeenCalledWith("streamers");
    expect(mockSupabase.query.select).toHaveBeenCalledWith("gacha_sound_url, gacha_sound_enabled");
    expect(mockSupabase.query.eq).toHaveBeenCalledWith("id", "streamer-1");
  });

  it("keeps streamer-not-found as a 404", async () => {
    const mockSupabase = createSoundSettingsClient({
      data: null,
      error: null,
      status: 200,
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>);

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: "missing-streamer" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Streamer not found" });
  });

  it("falls back to disabled sound settings when the database returns a transient 520", async () => {
    const mockSupabase = createSoundSettingsClient({
      data: null,
      error: { message: "error code: 520" },
      status: 520,
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as unknown as ReturnType<typeof getSupabaseAdmin>);

    const response = await GET(request(), {
      params: Promise.resolve({ streamerId: "streamer-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      soundUrl: null,
      soundEnabled: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Streamer Sound Settings API: falling back to disabled sound settings",
      {
        streamerId: "streamer-1",
        status: 520,
        error: "error code: 520",
      }
    );
  });
});
