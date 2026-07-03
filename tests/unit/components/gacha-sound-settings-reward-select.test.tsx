import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import GachaSoundSettings from "@/components/GachaSoundSettings";
import jaMessages from "../../../messages/ja.json";
import type { GachaSoundRule } from "@/lib/gacha-sound-rules";
import type { Json } from "@/types/database";

vi.mock("@/lib/logger");

// Issue #586: 「チャネルポイントIDだけ表示されても変更しようがない」— 報酬別
// 効果音ルールの対象選択を、生ID入力からChannelPointSettingsと同じ
// /api/twitch/rewards 取得プルダウンに置き換えた変更のリグレッションガード。

type FetchMock = ReturnType<typeof vi.fn>;

const REWARD_A = { id: "reward-a", title: "カードガチャ", cost: 100, is_enabled: true };
const REWARD_B = { id: "reward-b", title: "レア確定ガチャ", cost: 500, is_enabled: false };

function mockFetch(
  options: { rewardsOk?: boolean; rewards?: Array<typeof REWARD_A> } = {}
): FetchMock {
  const { rewardsOk = true, rewards = [REWARD_A, REWARD_B] } = options;

  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/twitch/rewards")) {
      if (!rewardsOk) {
        return new Response(JSON.stringify({ error: "fetch failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(rewards), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/api/streamer/settings")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Any other endpoint: respond with a benign empty payload.
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function rewardRuleFixture(overrides: Partial<GachaSoundRule> = {}): GachaSoundRule {
  return {
    id: "rule-1",
    url: "https://example.com/sound.mp3",
    enabled: true,
    label: "効果音",
    targetType: "reward",
    rarity: null,
    rewardId: "reward-a",
    rewardName: "カードガチャ",
    ...overrides,
  };
}

function renderComponent(props: Partial<React.ComponentProps<typeof GachaSoundSettings>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <GachaSoundSettings
        streamerId="streamer-1"
        plan="support"
        currentSoundUrl={null}
        currentSoundEnabled={false}
        currentSoundRules={[rewardRuleFixture()] as unknown as Json}
        currentRewardId="reward-a"
        currentRewardName="カードガチャ"
        {...props}
      />
    </NextIntlClientProvider>
  );
}

describe("GachaSoundSettings reward select (Issue #586)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the reward select (not a raw ID input) populated with fetched reward titles + cost", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("対象の報酬")).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "カードガチャ (100 ポイント)" })).toBeInTheDocument();
    // Disabled rewards are still selectable but visibly marked.
    expect(screen.getByRole("option", { name: "レア確定ガチャ (500 ポイント)[無効]" })).toBeInTheDocument();
    // The old raw-ID input must be gone once the select is available.
    expect(screen.queryByLabelText("報酬ID")).not.toBeInTheDocument();
  });

  it("includes an unset option so a rule can be left without a reward target", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "-- 報酬を選択 --" })).toBeInTheDocument();
    });
  });

  it("keeps a rule's current rewardId selectable even if it is missing from the fetched list (orphan/deleted reward)", async () => {
    vi.stubGlobal("fetch", mockFetch({ rewards: [REWARD_A] }));
    renderComponent({
      currentSoundRules: [
        rewardRuleFixture({ rewardId: "reward-deleted", rewardName: "廃止済み報酬" }),
      ] as unknown as Json,
    });

    const select = (await screen.findByLabelText("対象の報酬")) as HTMLSelectElement;
    expect(select.value).toBe("reward-deleted");
    expect(
      screen.getByRole("option", {
        name: "廃止済み報酬（Twitchで削除された可能性があります。現在の設定は維持されています）",
      })
    ).toBeInTheDocument();
  });

  it("falls back to the raw reward-ID text input when the reward list fetch fails", async () => {
    vi.stubGlobal("fetch", mockFetch({ rewardsOk: false }));
    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("報酬ID")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("対象の報酬")).not.toBeInTheDocument();
    expect(
      screen.getByText("報酬一覧を取得できませんでした。報酬IDを直接入力してください。")
    ).toBeInTheDocument();
  });

  it("does not call the rewards endpoint for basic-plan (non-premium) users, and still shows the text-input fallback", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ plan: "basic" });

    await waitFor(() => {
      expect(screen.getByLabelText("報酬ID")).toBeInTheDocument();
    });
    const calledRewardsEndpoint = fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/twitch/rewards")
    );
    expect(calledRewardsEndpoint).toBe(false);
  });

  it("saves the same rule payload shape as before when a reward is picked from the dropdown", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderComponent();

    const select = (await screen.findByLabelText("対象の報酬")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "reward-b" } });

    await waitFor(() => {
      const settingsCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes("/api/streamer/settings")
      );
      expect(settingsCall).toBeDefined();
    });

    const settingsCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/streamer/settings")
    )!;
    const init = settingsCall[1] as RequestInit;
    const body = JSON.parse(init.body as string);

    // Payload shape (streamerId + gachaSoundRules array of rule objects) must be
    // unchanged from before this fix — only rewardId/rewardName values differ.
    expect(body).toEqual({
      streamerId: "streamer-1",
      gachaSoundRules: [
        {
          id: "rule-1",
          url: "https://example.com/sound.mp3",
          enabled: true,
          label: "効果音",
          targetType: "reward",
          rarity: null,
          rewardId: "reward-b",
          rewardName: "レア確定ガチャ",
        },
      ],
    });
  });

  it("clears rewardId/rewardName to null when the unset option is chosen (preserves existing null-means-inactive semantics)", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderComponent();

    const select = (await screen.findByLabelText("対象の報酬")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "" } });

    await waitFor(() => {
      const settingsCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes("/api/streamer/settings")
      );
      expect(settingsCall).toBeDefined();
    });

    const settingsCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/api/streamer/settings")
    )!;
    const init = settingsCall[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.gachaSoundRules[0].rewardId).toBeNull();
    expect(body.gachaSoundRules[0].rewardName).toBeNull();
  });
});
