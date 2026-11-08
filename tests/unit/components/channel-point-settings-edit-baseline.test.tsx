import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

type FetchMock = ReturnType<typeof vi.fn>;

// Issue #2005 (任意1): PUT 保存後の一覧再取得（GET）が失敗して黙って捨てられても、
// PUT 応答の確定行で一覧の比較基準が更新されることを検証する。
// 修正前は古い一覧が基準として残り、編集し直すと「現在値と同じ」と誤判定されて
// collectionNames が PUT ボディから省略される（= 変更が保存されない）穴があった。
const INITIAL_REWARDS = [
  {
    id: "ar-1",
    reward_id: "extra-reward-1",
    reward_name: "Extra 1",
    draw_count: 1,
    is_raid_limited: false,
    collection_name: "weapons",
    collection_names: ["weapons"],
    created_at: "2026-01-01T00:00:00.000Z",
  },
];

const UPDATED_REWARD_ROW = {
  ...INITIAL_REWARDS[0],
  collection_name: "characters",
  collection_names: ["characters"],
};

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

describe("ChannelPointSettings additional-reward edit baseline (Issue #2005)", () => {
  let fetchMock: FetchMock;
  const putBodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    putBodies.length = 0;

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
            ],
            subscriptions: [],
            additionalRewards: INITIAL_REWARDS,
            eventSubStatus: "active",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes("/api/streamer/additional-rewards") && method === "PUT") {
        const sent = JSON.parse(String(init?.body));
        putBodies.push(sent);
        // サーバは確定値を GET と同じ形で返す。collectionNames が省略された
        // （変更なし）PUT ではパック割り当ては現状維持なので、直前の値を返す。
        const names: string[] = sent.collectionNames ?? UPDATED_REWARD_ROW.collection_names;
        const reward = {
          ...UPDATED_REWARD_ROW,
          collection_name: names[0] ?? null,
          collection_names: names,
        };
        return new Response(JSON.stringify({ success: true, reward }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // PUT 後の一覧再取得（GET）は失敗させる。クライアント側の fetchAdditionalRewards は
      // 失敗を黙って捨てるため、一覧行の更新が PUT 応答に依存することが分離できる。
      if (url.includes("/api/streamer/additional-rewards") && method === "GET") {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
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

  it("GET 再取得が失敗しても PUT 応答で基準が更新され、編集し直した変更が省略されない", async () => {
    renderComponent();

    // 1回目の編集: weapons → characters へ変更して保存。
    fireEvent.click(await screen.findByRole("button", { name: "Extra 1のパック・枚数を編集" }));
    let group = await screen.findByRole("group", { name: "編集する引き換えのカードパック" });
    fireEvent.click(within(group).getByRole("checkbox", { name: "weapons" }));
    fireEvent.click(within(group).getByRole("checkbox", { name: "characters" }));
    fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));

    await waitFor(() => {
      expect(putBodies).toHaveLength(1);
      expect(screen.getByText("追加の引き換えを更新しました")).toBeInTheDocument();
    });
    expect(putBodies[0].collectionNames).toEqual(["characters"]);

    // 一覧再取得（GET）は 500 で失敗している。それでも編集フォームを開き直すと
    // PUT 応答の確定値（characters）がプリフィルされる = 基準が更新されている。
    fireEvent.click(await screen.findByRole("button", { name: "Extra 1のパック・枚数を編集" }));
    group = await screen.findByRole("group", { name: "編集する引き換えのカードパック" });
    expect(within(group).getByRole("checkbox", { name: "characters" })).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "weapons" })).not.toBeChecked();

    // 2回目の編集: characters → weapons へ戻す。基準が確定値（characters）なので
    // これは「変更あり」と判定され、collectionNames が PUT ボディへ乗る。
    fireEvent.click(within(group).getByRole("checkbox", { name: "characters" }));
    fireEvent.click(within(group).getByRole("checkbox", { name: "weapons" }));
    fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));

    await waitFor(() => {
      expect(putBodies).toHaveLength(2);
    });
    expect(putBodies[1].collectionNames).toEqual(["weapons"]);
  });
});
