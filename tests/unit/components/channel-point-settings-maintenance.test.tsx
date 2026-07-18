import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// #694 Stage 6c: ChannelPointSettings の書き込み経路
// (POST /api/twitch/rewards の報酬作成、POST /api/streamer/settings +
// POST /api/twitch/eventsub/subscribe の保存フロー等) に対するmaintenance統合
// テスト。

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(overrides: { rewards?: unknown[]; createRewardStatus?: number; createRewardBody?: unknown } = {}): FetchMock {
  const { rewards = [], createRewardStatus = 200, createRewardBody } = overrides;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

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
          requiresReauth: false,
          rewards,
          subscriptions: [],
          additionalRewards: [],
          eventSubStatus: "none",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/twitch/rewards") && method === "POST") {
      return new Response(
        JSON.stringify(createRewardBody ?? { error: "unexpected" }),
        { status: createRewardStatus, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function renderComponent(
  status: MaintenanceStatusResponse,
  props: Partial<React.ComponentProps<typeof ChannelPointSettings>> = {}
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <ChannelPointSettings
          streamerId="streamer-1"
          currentRewardId={null}
          currentRewardName={null}
          {...props}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

describe("ChannelPointSettings maintenance integration", () => {
  let fetchMock: FetchMock;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode=off のときは報酬作成ボタンが操作可能（既存挙動を壊さない）", async () => {
    fetchMock = mockFetch({ rewards: [] });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "off" });

    const createButton = await screen.findByRole("button", { name: "TwiCa用チャネルポイント引き換えを作成（100ポイント）" });
    expect(createButton).not.toBeDisabled();
  });

  it("mode!=off のときは報酬作成ボタンがdisableされ、案内文言が表示される（事前disable）", async () => {
    fetchMock = mockFetch({ rewards: [] });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "read-only" });

    const createButton = await screen.findByRole("button", { name: "TwiCa用チャネルポイント引き換えを作成（100ポイント）" });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveAttribute("title", "メンテナンス中は操作できません");
    expect(screen.getByText("メンテナンス中は操作できません")).toBeInTheDocument();
  });

  it("事前disableをすり抜けて報酬作成が503(maintenance)で拒否された場合、サーバーの案内文言を表示する", async () => {
    fetchMock = mockFetch({
      rewards: [],
      createRewardStatus: 503,
      createRewardBody: {
        error: {
          code: "maintenance_read_only",
          message: "ただいまメンテナンス中です。しばらくしてから再度お試しください。",
          retryable: true,
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "off" });

    const createButton = await screen.findByRole("button", { name: "TwiCa用チャネルポイント引き換えを作成（100ポイント）" });
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(
        screen.getByText("ただいまメンテナンス中です。しばらくしてから再度お試しください。")
      ).toBeInTheDocument();
    });
  });

  it("メイン保存ボタンはmode!=offでdisableされる", async () => {
    fetchMock = mockFetch({ rewards: [{ id: "main-reward", title: "Main", cost: 100, is_enabled: true }] });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ mode: "read-only" }, { currentRewardId: "main-reward", currentRewardName: "Main" });

    const saveButton = await screen.findByRole("button", { name: "保存 & EventSub登録" });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute("title", "メンテナンス中は操作できません");
  });
});
