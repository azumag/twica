/**
 * #540: src/lib/twitch/eventsub-subscriptions.ts のテスト
 *
 * fetchTwitchApi をモックして、ページネーション取得と unhealthy 判定ロジックを
 * 検証する（app access token の発行・キャッシュ自体は twitch-app-token.test.ts
 * で別途カバー済みのため、ここでは fetchTwitchApi の契約だけを前提にする）。
 */
import { readFileSync } from "fs";
import { resolve } from "path";
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
    "moderator_removed",
    "chat_user_banned",
    "version_removed",
  ])("%sはunhealthyと判定する", async (status) => {
    const { isUnhealthyEventSubStatus } = await import("@/lib/twitch/eventsub-subscriptions");
    expect(isUnhealthyEventSubStatus(status)).toBe(true);
  });

  // PR #1009 レビュー指摘(必須): eventsub/route.ts の revocation webhook
  // ハンドラは Issue #285 の方針で authorization_revoked / user_removed を
  // 「ユーザー起因の期待される挙動」として reportError しない。健全性監視が
  // これらを unhealthy 扱いすると #285 への退行になる上、配信者が自分の意思で
  // 連携解除しただけの状態が「対応すれば直る」インフラ障害と誤認されて
  // 5分毎に恒久的にアラートされ続けてしまう。
  it.each(["authorization_revoked", "user_removed"])(
    "%sはユーザー起因の期待される終端状態としてunhealthy扱いしない(Issue #285)",
    async (status) => {
      const { isUnhealthyEventSubStatus } = await import("@/lib/twitch/eventsub-subscriptions");
      expect(isUnhealthyEventSubStatus(status)).toBe(false);
    }
  );
});

// ===========================================================================
// ドリフト検知契約テスト: EXPECTED_USER_INITIATED_EVENTSUB_STATUSES と
// eventsub/route.ts の EXPECTED_REVOCATIONS が実際に一致することを検証する。
// 両者は意図的に独立した実装(コメントでの相互参照のみ)なので、片方だけが
// 変更されたらこのテストが機械的に赤くなるようにする（error-reporter-worker
// のwrangler.toml crons ドリフトテストと同じ「ソースを正規表現で読んで突き合わせる」方式）。
// ===========================================================================
describe("EXPECTED_USER_INITIATED_EVENTSUB_STATUSES と eventsub/route.ts のドリフト検知", () => {
  it("値が完全に一致する", async () => {
    const { EXPECTED_USER_INITIATED_EVENTSUB_STATUSES } = await import(
      "@/lib/twitch/eventsub-subscriptions"
    );

    const routeSource = readFileSync(
      resolve(__dirname, "../../src/app/api/twitch/eventsub/route.ts"),
      "utf-8"
    );
    const match = routeSource.match(/EXPECTED_REVOCATIONS\s*=\s*\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const routeValues = (match?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^['"](.*)['"]$/, "$1"))
      .filter(Boolean);

    expect(new Set(routeValues)).toEqual(EXPECTED_USER_INITIATED_EVENTSUB_STATUSES);
  });
});
