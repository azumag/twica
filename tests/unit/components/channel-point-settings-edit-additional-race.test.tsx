import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

type FetchMock = ReturnType<typeof vi.fn>;

const ADDITIONAL_REWARDS = [
  {
    id: "ar-1",
    reward_id: "extra-reward-1",
    reward_name: "Extra 1",
    draw_count: 3,
    is_raid_limited: false,
    collection_name: "weapons",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "ar-2",
    reward_id: "extra-reward-2",
    reward_name: "Extra 2",
    draw_count: 1,
    is_raid_limited: false,
    collection_name: "characters",
    created_at: "2026-01-02T00:00:00.000Z",
  },
];

function renderComponent() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={{ mode: "off" } as unknown as MaintenanceStatusResponse}>
        <ChannelPointSettings
          streamerId="streamer-1"
          currentRewardId="main-reward"
          currentRewardName="Main"
          currentCollectionName={null}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

describe("ChannelPointSettings additional-reward edit race", () => {
  let resolvePut: ((response: Response) => void) | undefined;
  let fetchMock: FetchMock;

  beforeEach(() => {
    const pendingPut = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });

    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url.includes("/api/cards/collections")) {
        return new Response(JSON.stringify({ collections: ["characters", "weapons"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/api/twitch/channel-point-bootstrap")) {
        return new Response(
          JSON.stringify({
            hasRequiredScope: true,
            requiresReauth: false,
            rewards: [
              { id: "main-reward", title: "Main", cost: 100, is_enabled: true },
              { id: "extra-reward-1", title: "Extra 1", cost: 200, is_enabled: true },
              { id: "extra-reward-2", title: "Extra 2", cost: 300, is_enabled: true },
            ],
            subscriptions: [],
            additionalRewards: ADDITIONAL_REWARDS,
            eventSubStatus: "active",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes("/api/streamer/additional-rewards") && method === "GET") {
        return new Response(JSON.stringify(ADDITIONAL_REWARDS), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/api/streamer/additional-rewards") && method === "PUT") {
        return pendingPut;
      }

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a newly opened reward editor when an earlier PUT finishes with 404", async () => {
    renderComponent();

    fireEvent.click(await screen.findByRole("button", { name: "Extra 1のパック・枚数を編集" }));
    await screen.findByLabelText("編集する引き換えのカードパック");

    fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes("/api/streamer/additional-rewards") &&
            (init as RequestInit)?.method === "PUT"
        )
      ).toBe(true);
    });

    // PUT が未完了の間に別行へ編集対象を切り替える。入力は未変更なので確認ダイアログは不要。
    fireEvent.click(screen.getByRole("button", { name: "Extra 2のパック・枚数を編集" }));

    const secondPackSelect = screen.getByLabelText("編集する引き換えのカードパック") as HTMLSelectElement;
    expect(secondPackSelect.value).toBe("characters");
    expect((screen.getByLabelText("一度に排出する枚数（編集）") as HTMLInputElement).value).toBe("1");

    resolvePut?.(
      new Response(
        JSON.stringify({ error: "この追加の引き換えは既に削除されています。設定を再読み込みしてください" }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    );

    await waitFor(() => {
      expect(
        screen.getByText("この追加の引き換えは既に削除されています。設定を再読み込みしてください")
      ).toBeInTheDocument();
    });

    // 404 は保存開始時の行だけを閉じる対象にし、後から開いた別行のフォームは保持する。
    expect(screen.getByRole("button", { name: "Extra 2のパック・枚数を編集" })).toBeDisabled();
    expect((screen.getByLabelText("編集する引き換えのカードパック") as HTMLSelectElement).value).toBe("characters");
    expect(screen.getByRole("button", { name: "キャンセル" })).toBeInTheDocument();
  });
});
