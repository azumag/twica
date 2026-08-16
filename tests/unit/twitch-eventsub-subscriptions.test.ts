/**
 * #540: src/lib/twitch/eventsub-subscriptions.ts のテスト
 *
 * fetchTwitchApi をモックして、ページネーション取得と unhealthy 判定ロジックを
 * 検証する（app access token の発行・キャッシュ自体は twitch-app-token.test.ts
 * で別途カバー済みのため、ここでは fetchTwitchApi の契約だけを前提にする）。
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTwitchApi: vi.fn(),
}));

vi.mock("@/lib/twitch/app-token", () => ({
  fetchTwitchApi: mocks.fetchTwitchApi,
}));

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("listAllEventSubSubscriptions", () => {
  it("cursorが無くなるまでページネーションして全件結合する", async () => {
    mocks.fetchTwitchApi
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "sub-1", status: "enabled", type: "channel.channel_points_custom_reward_redemption.add", condition: {}, transport: { method: "webhook", callback: "" }, created_at: "2026-01-01T00:00:00Z" }],
          pagination: { cursor: "cursor-1" },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "sub-2", status: "enabled", type: "channel.raid", condition: {}, transport: { method: "webhook", callback: "" }, created_at: "2026-01-01T00:00:00Z" }],
          pagination: {},
        })
      );

    const { listAllEventSubSubscriptions } = await import("@/lib/twitch/eventsub-subscriptions");
    const result = await listAllEventSubSubscriptions();

    expect(result.map((s) => s.id)).toEqual(["sub-1", "sub-2"]);
    expect(mocks.fetchTwitchApi).toHaveBeenCalledTimes(2);
    expect(mocks.fetchTwitchApi).toHaveBeenNthCalledWith(2, expect.stringContaining("after=cursor-1"));
  });

  it("非2xxレスポンスは例外を投げる", async () => {
    mocks.fetchTwitchApi.mockResolvedValueOnce(jsonResponse({}, false));

    const { listAllEventSubSubscriptions } = await import("@/lib/twitch/eventsub-subscriptions");

    await expect(listAllEventSubSubscriptions()).rejects.toThrow(
      "Failed to fetch EventSub subscriptions: 500"
    );
  });
});

describe("isUnhealthyEventSubStatus", () => {
  it("enabledは健全と判定する", async () => {
    const { isUnhealthyEventSubStatus } = await import("@/lib/twitch/eventsub-subscriptions");
    expect(isUnhealthyEventSubStatus("enabled")).toBe(false);
  });

  it("webhook_callback_verification_pendingは一過性として健全扱いする", async () => {
    const { isUnhealthyEventSubStatus } = await import("@/lib/twitch/eventsub-subscriptions");
    expect(isUnhealthyEventSubStatus("webhook_callback_verification_pending")).toBe(false);
  });

  it.each([
    "webhook_callback_verification_failed",
    "notification_failures_exceeded",
    "authorization_revoked",
    "moderator_removed",
    "user_removed",
    "chat_user_banned",
    "version_removed",
  ])("%sはunhealthyと判定する", async (status) => {
    const { isUnhealthyEventSubStatus } = await import("@/lib/twitch/eventsub-subscriptions");
    expect(isUnhealthyEventSubStatus(status)).toBe(true);
  });
});
