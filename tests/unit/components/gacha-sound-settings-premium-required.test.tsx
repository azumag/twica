import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import GachaSoundSettings from "@/components/GachaSoundSettings";
import jaMessages from "../../../messages/ja.json";
import type { GachaSoundRule } from "@/lib/gacha-sound-rules";
import type { Json } from "@/types/database";

vi.mock("@/lib/logger");

const rule: GachaSoundRule = {
  id: "rule-1",
  url: "https://example.com/sound.mp3",
  enabled: true,
  label: "効果音",
  targetType: "all",
  rarity: null,
  rewardId: null,
  rewardName: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("GachaSoundSettings premium-required save response", () => {
  it("gachaSoundRulesPremiumRequiredを受信すると制限メッセージを表示する", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/twitch/rewards")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/api/streamer/settings")) {
        return new Response(
          JSON.stringify({
            success: true,
            gachaSoundRules: [{ ...rule, enabled: false }],
            gachaSoundRulesPremiumRequired: true,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    // supportプランでは制限バナーが初期表示されないため、API応答で表示された
    // premiumRequiredメッセージだけを独立して検証できる。
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <GachaSoundSettings
          streamerId="streamer-1"
          plan="support"
          currentSoundUrl={null}
          currentSoundEnabled={false}
          currentSoundRules={[rule] as unknown as Json}
          currentRewardId={null}
          currentRewardName={null}
        />
      </NextIntlClientProvider>
    );

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("/api/twitch/rewards"))
      ).toBe(true);
    });
    expect(
      screen.queryByText("複数効果音・ターゲット指定は助力プラン以上の機能です。")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("効果音を有効にする"));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("/api/streamer/settings"))
      ).toBe(true);
    });
    expect(
      await screen.findByText("複数効果音・ターゲット指定は助力プラン以上の機能です。")
    ).toBeInTheDocument();
  });
});
