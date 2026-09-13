import { describe, expect, it } from "vitest";

// このテストでは意図的に env-validation 等を mock しない。
// `@/lib/twitch/scopes` は "use client" コンポーネントからも import されるため、
// サーバー専用依存を追加した場合はモジュール評価時に検知できる状態を維持する。
describe("@/lib/twitch/scopes client-safe contract", () => {
  it("server-only 依存なしで scope 定義を読み込める", async () => {
    const mod = await import("@/lib/twitch/scopes");

    expect(mod.AUTH_SCOPES).toBe("user:read:email");
    expect(mod.ADDITIONAL_SCOPES).toMatchObject({
      CHAT_WRITE: "user:write:chat",
      USER_READ_SUBSCRIPTIONS: "user:read:subscriptions",
      CHANNEL_READ_REDEMPTIONS: "channel:read:redemptions",
      CHANNEL_MANAGE_REDEMPTIONS: "channel:manage:redemptions",
    });
    expect(mod.CHANNEL_POINT_SCOPES).toEqual([
      "channel:read:redemptions",
      "channel:manage:redemptions",
    ]);
  });
});
