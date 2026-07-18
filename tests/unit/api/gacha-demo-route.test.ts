/**
 * Issue #783: POST /api/gacha/demo は認証不要の公開デモエンドポイントだが、
 * broadcast=true かつ streamerId 指定の場合のみ「任意の配信者のオーバーレイに
 * Supabase Realtime経由で演出をブロードキャストできてしまう」実害があった。
 * #781（/api/gacha route）と同じ「呼び出し元は自分のstreamerIdに対してのみ
 * broadcastできる」制限を追加したことを検証する。
 *
 * broadcastを伴わない既存の公開デモ機能（overlay/[streamerId]/page.tsxの
 * triggerDemoなど、未ログインでも動作する経路）には一切影響しないことも確認する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/gacha/demo/route";
import { getSession } from "@/lib/session";
import { getStreamerIdByTwitchUserId } from "@/lib/user-data";
import { broadcastGachaResult } from "@/lib/realtime";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/session");
vi.mock("@/lib/user-data");
vi.mock("@/lib/realtime", () => ({
  broadcastGachaResult: vi.fn(() => Promise.resolve()),
}));
// fable review追加指摘: broadcast経路の専用レート制限(rateLimits.gachaDemoBroadcast)
// を検証するため、rate-limit モジュール全体をモックする。rateLimits はキーが
// 存在すれば中身は問わない（checkRateLimit の呼び出し先はモックで差し替わるため）。
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  getRateLimitIdentifier: vi.fn(),
  rateLimits: { gachaDemoBroadcast: {} },
}));

const mockGetSession = vi.mocked(getSession);
const mockGetStreamerIdByTwitchUserId = vi.mocked(getStreamerIdByTwitchUserId);
const mockBroadcastGachaResult = vi.mocked(broadcastGachaResult);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetRateLimitIdentifier = vi.mocked(getRateLimitIdentifier);

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/gacha/demo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/gacha/demo: broadcast時の自チャンネル制限 (#783)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // pg経路・supabase-js経路のどちらも通らないようにし、DEMO_CARDSへの
    // フォールバックだけで完結させる（このテストの関心事はbroadcast前の401/403判定）。
    delete process.env.DB_DRIVER;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    // レート制限は既定で「制限内」を返す。制限超過を検証するテストだけ
    // mockCheckRateLimit を上書きする。
    mockGetRateLimitIdentifier.mockResolvedValue("user:twitch-1");
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 30,
      remaining: 29,
      reset: Date.now() + 60_000,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("broadcast:true かつ未ログインの場合は401を返し、ブロードキャストしない", async () => {
    // fable review追加指摘: 未ログインは403 FORBIDDENではなく401 UNAUTHORIZED
    // （/api/gacha routeと同じ区別: 未ログイン=401、所有者不一致=403）。
    mockGetSession.mockResolvedValue(null);

    const res = await POST(makeRequest({ streamerId: "streamer-1", broadcast: true }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual({ error: ERROR_MESSAGES.UNAUTHORIZED });
    expect(mockBroadcastGachaResult).not.toHaveBeenCalled();
  });

  it("broadcast:true かつ他人のstreamerIdを指定した場合は403を返し、ブロードキャストしない", async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: "twitch-1",
      twitchUsername: "user1",
      broadcasterType: "affiliate",
    } as Awaited<ReturnType<typeof getSession>>);
    // twitch-1が所有するのはstreamer-1で、streamer-2ではない
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: "streamer-1" });

    const res = await POST(makeRequest({ streamerId: "streamer-2", broadcast: true }));

    expect(res.status).toBe(403);
    expect(mockBroadcastGachaResult).not.toHaveBeenCalled();
  });

  it("broadcast:true かつ配信者未登録ユーザーの場合は403を返す", async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: "twitch-1",
      twitchUsername: "user1",
      broadcasterType: "affiliate",
    } as Awaited<ReturnType<typeof getSession>>);
    mockGetStreamerIdByTwitchUserId.mockResolvedValue(null);

    const res = await POST(makeRequest({ streamerId: "streamer-1", broadcast: true }));

    expect(res.status).toBe(403);
    expect(mockBroadcastGachaResult).not.toHaveBeenCalled();
  });

  it("broadcast:true かつ自分のstreamerIdを指定した場合は成功し、ブロードキャストされる", async () => {
    mockGetSession.mockResolvedValue({
      twitchUserId: "twitch-1",
      twitchUsername: "user1",
      broadcasterType: "affiliate",
    } as Awaited<ReturnType<typeof getSession>>);
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: "streamer-1" });

    const res = await POST(makeRequest({ streamerId: "streamer-1", broadcast: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.card).toBeDefined();
    expect(mockBroadcastGachaResult).toHaveBeenCalledWith(
      "streamer-1",
      expect.objectContaining({ type: "gacha" })
    );
    // fable review追加指摘: 認可チェック通過後にsession.twitchUserIdベースの
    // 識別子でレート制限をチェックしていること（IPフォールバックではない）。
    expect(mockGetRateLimitIdentifier).toHaveBeenCalledWith(
      expect.anything(),
      "twitch-1"
    );
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it("broadcast:true かつ自分のstreamerId指定時にレート制限を超過した場合は429を返し、ブロードキャストしない", async () => {
    // fable review追加指摘: broadcast経路専用のレート制限
    // (rateLimits.gachaDemoBroadcast)を検証する。認可チェックには通るが
    // レート制限に引っかかるケース。
    mockGetSession.mockResolvedValue({
      twitchUserId: "twitch-1",
      twitchUsername: "user1",
      broadcasterType: "affiliate",
    } as Awaited<ReturnType<typeof getSession>>);
    mockGetStreamerIdByTwitchUserId.mockResolvedValue({ id: "streamer-1" });
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 60_000,
    });

    const res = await POST(makeRequest({ streamerId: "streamer-1", broadcast: true }));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).toBe(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(mockBroadcastGachaResult).not.toHaveBeenCalled();
  });

  it("broadcastなし（overlay/[streamerId]ページの公開デモ経路）は未ログインでも従来通り動作し、getSessionを呼ばない", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(makeRequest({ streamerId: "streamer-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.card).toBeDefined();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockBroadcastGachaResult).not.toHaveBeenCalled();
    // fable review追加指摘: broadcastなし経路は新設のレート制限にも一切触れない。
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("streamerId未指定でbroadcast:trueの場合は認証チェックをスキップする（従来通りブロードキャストは発生しない）", async () => {
    const res = await POST(makeRequest({ broadcast: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.card).toBeDefined();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockBroadcastGachaResult).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});
