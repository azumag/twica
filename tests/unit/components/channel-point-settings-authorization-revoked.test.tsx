import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

const AUTHORIZATION_REVOKED_RETRY_GUIDANCE =
  "そのうえで「保存 & EventSub登録」ボタンで登録し直してください";

function renderComponent() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={{ mode: "off" }}>
        <ChannelPointSettings
          streamerId="streamer-1"
          currentRewardId="reward-1"
          currentRewardName="Reward1"
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

describe("ChannelPointSettings authorization_revoked banner", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("再連携CTAとEventSub再登録案内を同じバナー内に表示する（Issue #1019）", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/cards/collections")) {
        return new Response(JSON.stringify({ collections: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/twitch/channel-point-bootstrap")) {
        return new Response(
          JSON.stringify({
            hasRequiredScope: true,
            rewards: [{ id: "reward-1", title: "Reward1", cost: 100, is_enabled: true }],
            subscriptions: [
              {
                id: "sub-1",
                status: "authorization_revoked",
                type: "channel.channel_points_custom_reward_redemption.add",
                condition: { broadcaster_user_id: "user-1", reward_id: "reward-1" },
                transport: { callback: "https://example.com/api/twitch/eventsub" },
              },
            ],
            additionalRewards: [],
            eventSubStatus: "error",
            raidEventSubStatus: "active",
            raidGiftDrawCount: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent();

    const bannerTitle = await screen.findByText("認証が取り消されました");
    const banner = bannerTitle.closest("div");
    expect(banner).not.toBeNull();

    const revokedBanner = within(banner as HTMLElement);
    expect(revokedBanner.getByText(AUTHORIZATION_REVOKED_RETRY_GUIDANCE)).toBeInTheDocument();
    expect(
      revokedBanner.getByRole("button", { name: "チャネルポイント連携を有効化" })
    ).not.toBeDisabled();
  });
});
