import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/gacha/route";
import { GachaService } from "@/lib/services/gacha";
import { getSession } from "@/lib/session";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/rate-limit";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { publishCommittedGachaBatch } from "@/lib/overlay-realtime/publisher";
import { getStreamerIdByTwitchUserId } from "@/lib/user-data";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/csrf");
vi.mock("@/lib/request-validation");
vi.mock("@/lib/overlay-realtime/publisher");
vi.mock("@/lib/services/gacha");
vi.mock("@/lib/user-data");

const mockGetSession = vi.mocked(getSession);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);
const mockValidateContentType = vi.mocked(validateContentType);
const mockPublishCommittedGachaBatch = vi.mocked(publishCommittedGachaBatch);
const MockGachaService = vi.mocked(GachaService);
const mockGetStreamerIdByTwitchUserId = vi.mocked(getStreamerIdByTwitchUserId);

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/gacha", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const sampleCard = {
  id: "card-1",
  name: "Test Card",
  description: "desc",
  image_url: "https://example.com/card.png",
  rarity: "common",
};

describe("POST /api/gacha", () => {
  let executeGachaMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      twitchUserId: "twitch-1",
      twitchUsername: "user1",
      broadcasterType: "affiliate",
    } as Awaited<ReturnType<typeof getSession>>);
    mockGetRateLimitIdentifier.mockResolvedValue("identifier");
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
    mockValidateContentType.mockReturnValue(null);
    mockPublishCommittedGachaBatch.mockResolvedValue({
      outcome: "accepted",
      attempts: 1,
    });
    // Issue #781: 自チャンネル制限のデフォルトは「呼び出し者(twitch-1)が
    // streamer-1の持ち主」。既存テストはいずれも streamerId: "streamer-1" を
    // 使っているため、このデフォルトのままなら全て通る。
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: "streamer-1" });

    executeGachaMock = vi.fn().mockResolvedValue({
      success: true,
      data: { card: sampleCard, userTwitchUsername: "user1" },
    });
    MockGachaService.mockImplementation(() => ({
      executeGachaWithRepeatProtection: executeGachaMock,
    }) as unknown as GachaService);
  });

  // Issue #661: execute_gacha_transaction RPC (migration 00076) now rejects
  // p_event_id = NULL. This route previously called executeGacha without an
  // eventId at all, which propagated as NULL all the way to the RPC. It must
  // now always supply a non-null, per-request-unique synthetic event id so
  // the manual "draw a real gacha" flow keeps working.
  it("passes a non-null, non-empty eventId to GachaService.executeGachaWithRepeatProtection", async () => {
    const res = await POST(makeRequest({ streamerId: "streamer-1" }));

    expect(res.status).toBe(200);
    expect(executeGachaMock).toHaveBeenCalledTimes(1);
    const eventIdArg = executeGachaMock.mock.calls[0][3];
    expect(eventIdArg).toBeTruthy();
    expect(typeof eventIdArg).toBe("string");
  });

  it("generates a distinct eventId on every call (no accidental dedup across separate draws)", async () => {
    await POST(makeRequest({ streamerId: "streamer-1" }));
    await POST(makeRequest({ streamerId: "streamer-1" }));

    const firstEventId = executeGachaMock.mock.calls[0][3];
    const secondEventId = executeGachaMock.mock.calls[1][3];
    expect(firstEventId).not.toBe(secondEventId);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ streamerId: "streamer-1" }));
    expect(res.status).toBe(401);
    expect(executeGachaMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the CSRF token is invalid", async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false });
    const res = await POST(makeRequest({ streamerId: "streamer-1" }));
    expect(res.status).toBe(403);
    expect(executeGachaMock).not.toHaveBeenCalled();
  });

  it("returns 500 when GachaService.executeGachaWithRepeatProtection fails", async () => {
    executeGachaMock.mockResolvedValue({
      success: false,
      error: "Failed to execute gacha transaction: event_id must not be null",
    });
    const res = await POST(makeRequest({ streamerId: "streamer-1" }));
    expect(res.status).toBe(500);
  });

  // Issue #781: このQA用手動ドローAPIはチャンネルポイント消費を検証しないため、
  // サーバー側で「呼び出し者自身のstreamerIdか」のチェックが無いと、ログイン済み
  // ユーザーが任意のstreamerIdに対してポイント消費なしの実ドローを行えてしまう。
  describe("self-channel restriction (#781)", () => {
    it("returns 403 when streamerId does not belong to the caller", async () => {
      // twitch-1 (呼び出し者) が所有するのは streamer-1 であり、streamer-2 では
      // ない。他人のstreamerIdへのリクエストは拒否されるべき。
      mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: "streamer-1" });

      const res = await POST(makeRequest({ streamerId: "streamer-2" }));

      expect(res.status).toBe(403);
      expect(executeGachaMock).not.toHaveBeenCalled();
      expect(mockPublishCommittedGachaBatch).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller has no streamer row at all", async () => {
      // getStreamerIdByTwitchUserId(#711) は「配信者登録なし/クエリエラー」を
      // 区別せず null を返す契約(user-data.tsのコメント参照)。この場合も
      // どのstreamerIdに対しても403にすべき。
      mockGetStreamerIdByTwitchUserId.mockResolvedValue(null);

      const res = await POST(makeRequest({ streamerId: "streamer-1" }));

      expect(res.status).toBe(403);
      expect(executeGachaMock).not.toHaveBeenCalled();
    });

    it("allows the draw when streamerId matches the caller's own streamer", async () => {
      mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: "streamer-1" });

      const res = await POST(makeRequest({ streamerId: "streamer-1" }));

      expect(res.status).toBe(200);
      expect(mockGetStreamerIdByTwitchUserId).toHaveBeenCalledWith("twitch-1");
      expect(executeGachaMock).toHaveBeenCalledTimes(1);
    });
  });
});