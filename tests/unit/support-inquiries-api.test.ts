import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/support-inquiries/route";
import { DELETE as DELETE_DETAIL, GET as GET_DETAIL } from "@/app/api/support-inquiries/[id]/route";
import { POST as POST_MESSAGE } from "@/app/api/support-inquiries/[id]/messages/route";
import { getSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/plan";
import { validateCSRFToken } from "@/lib/csrf";

vi.mock("@/lib/session");
vi.mock("@/lib/rate-limit");
vi.mock("@/lib/plan");
vi.mock("@/lib/csrf");
vi.mock("@/lib/sentry/error-handler", () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
}));

const mockGetSession = vi.mocked(getSession);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockGetUserPlan = vi.mocked(getUserPlan);
const mockValidateCSRFToken = vi.mocked(validateCSRFToken);

const MOCK_SESSION = {
  twitchUserId: "user123",
  twitchUsername: "testuser",
  twitchDisplayName: "TestUser",
  twitchProfileImageUrl: "",
  broadcasterType: "" as const,
  expiresAt: Date.now() + 100000,
  version: 1,
};

function createGetRequest(path = "/api/support-inquiries"): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`));
}

function createPostRequest(
  body: Record<string, unknown>,
  path = "/api/support-inquiries"
): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createDeleteRequest(path: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`), {
    method: "DELETE",
  });
}

describe("GET /api/support-inquiries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60000,
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET(createGetRequest());
    expect(res.status).toBe(401);
  });

  it("returns 403 when user has basic plan", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("basic");
    const res = await GET(createGetRequest());
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("patron");
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 60000,
    });

    const res = await GET(createGetRequest());
    expect(res.status).toBe(429);
  });
});

describe("POST /api/support-inquiries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 3600000,
    });
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
  });

  it("returns 403 when CSRF token is invalid", async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false });
    const res = await POST(
      createPostRequest({ category: "bug", subject: "Test", body: "Body" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(
      createPostRequest({ category: "bug", subject: "Test", body: "Body" })
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when user has basic plan", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("basic");
    const res = await POST(
      createPostRequest({ category: "bug", subject: "Test", body: "Body" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid category", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    const res = await POST(
      createPostRequest({
        category: "invalid",
        subject: "Test",
        body: "Body",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when subject is empty", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    const res = await POST(
      createPostRequest({ category: "bug", subject: "", body: "Body" })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when subject exceeds 200 chars", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    const res = await POST(
      createPostRequest({
        category: "bug",
        subject: "a".repeat(201),
        body: "Body",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    const res = await POST(
      createPostRequest({ category: "bug", subject: "Test", body: "" })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when body exceeds 2000 chars", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    const res = await POST(
      createPostRequest({
        category: "bug",
        subject: "Test",
        body: "a".repeat(2001),
      })
    );
    expect(res.status).toBe(400);
  });

});

describe("GET /api/support-inquiries/[id]", () => {
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60000,
    });
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await GET_DETAIL(
      createGetRequest(`/api/support-inquiries/${VALID_UUID}`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid UUID format", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    const res = await GET_DETAIL(
      createGetRequest("/api/support-inquiries/invalid-id"),
      { params: Promise.resolve({ id: "invalid-id" }) }
    );
    expect(res.status).toBe(400);
  });

});

describe("DELETE /api/support-inquiries/[id]", () => {
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60000,
    });
  });

  it("returns 403 when CSRF token is invalid", async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false });
    const res = await DELETE_DETAIL(
      createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await DELETE_DETAIL(
      createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid UUID format", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    const res = await DELETE_DETAIL(
      createDeleteRequest("/api/support-inquiries/invalid-id"),
      { params: Promise.resolve({ id: "invalid-id" }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60000,
    });

    const res = await DELETE_DETAIL(
      createDeleteRequest(`/api/support-inquiries/${VALID_UUID}`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );

    expect(res.status).toBe(429);
  });

});

describe("POST /api/support-inquiries/[id]/messages", () => {
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60000,
    });
    mockValidateCSRFToken.mockResolvedValue({ valid: true });
  });

  it("returns 403 when CSRF is invalid", async () => {
    mockValidateCSRFToken.mockResolvedValue({ valid: false });
    const res = await POST_MESSAGE(
      createPostRequest(
        { body: "Reply" },
        `/api/support-inquiries/${VALID_UUID}/messages`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST_MESSAGE(
      createPostRequest(
        { body: "Reply" },
        `/api/support-inquiries/${VALID_UUID}/messages`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when body is empty", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    const res = await POST_MESSAGE(
      createPostRequest(
        { body: "" },
        `/api/support-inquiries/${VALID_UUID}/messages`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when body exceeds 2000 chars", async () => {
    mockGetSession.mockResolvedValue(MOCK_SESSION);
    mockGetUserPlan.mockResolvedValue("support");
    const res = await POST_MESSAGE(
      createPostRequest(
        { body: "a".repeat(2001) },
        `/api/support-inquiries/${VALID_UUID}/messages`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(400);
  });

});
