import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// 追加報酬の編集機能（パック変更・枚数変更）の回帰ガード。
// - 一覧の「編集」ボタンでインラインフォームが開く
// - 更新すると PUT /api/streamer/additional-rewards が呼ばれ、一覧が再取得される
// - キャンセルでフォームが閉じる

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(): FetchMock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
            { id: "extra-reward", title: "Extra", cost: 200, is_enabled: true },
          ],
          subscriptions: [],
          // bootstrap 経路でも collection_name が欠落しないこと（表示バグの回帰ガード）
          additionalRewards: [
            {
              id: "ar-1",
              reward_id: "extra-reward",
              reward_name: "Extra",
              draw_count: 3,
              is_raid_limited: false,
              collection_name: "weapons",
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          eventSubStatus: "active",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/streamer/additional-rewards") && method === "GET") {
      return new Response(
        JSON.stringify([
          {
            id: "ar-1",
            reward_id: "extra-reward",
            reward_name: "Extra",
            draw_count: 3,
            is_raid_limited: false,
            collection_name: "weapons",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/streamer/additional-rewards") && method === "PUT") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return fetchMock;
}

function renderComponent(props: Partial<React.ComponentProps<typeof ChannelPointSettings>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <ChannelPointSettings
        streamerId="streamer-1"
        currentRewardId="main-reward"
        currentRewardName="Main"
        currentCollectionName={null}
        {...props}
      />
    </NextIntlClientProvider>
  );
}

describe("ChannelPointSettings additional-reward editing", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the bound pack badge from the bootstrap response", async () => {
    renderComponent();

    await waitFor(() => {
      // 追加報酬一覧のパックバッジが「すべてのカード」ではなく実パック名になる
      // （プルダウンの option にも同じ名前があるため getAllByText で確認する）
      expect(screen.getAllByText("weapons").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("opens the inline edit form prefilled with the current binding", async () => {
    renderComponent();

    const editButton = await screen.findByRole("button", { name: "編集" });
    fireEvent.click(editButton);

    // 編集フォームが表示され、パック選択に現在値（weapons）がプリフィルされる
    const packSelect = (await screen.findByLabelText("編集する引き換えのカードパック")) as HTMLSelectElement;
    expect(packSelect.value).toBe("weapons");
    // 枚数入力も現在値（3連）がプリフィルされる
    const drawCountInput = screen.getByDisplayValue("3") as HTMLInputElement;
    expect(drawCountInput).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "変更を保存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "キャンセル" })).toBeInTheDocument();
  });

  it("sends a PUT with the new collection and draw count, then closes the form", async () => {
    renderComponent();

    const editButton = await screen.findByRole("button", { name: "編集" });
    fireEvent.click(editButton);

    const packSelect = (await screen.findByLabelText("編集する引き換えのカードパック")) as HTMLSelectElement;
    fireEvent.change(packSelect, { target: { value: "characters" } });
    const drawCountInput = screen.getByDisplayValue("3") as HTMLInputElement;
    fireEvent.change(drawCountInput, { target: { value: "5" } });

    fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes("/api/streamer/additional-rewards") && (init as RequestInit)?.method === "PUT"
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as RequestInit).body as string);
      expect(body).toEqual({
        rewardId: "extra-reward",
        collectionName: "characters",
        drawCount: 5,
      });
    });
    // 成功メッセージが表示され、編集フォームは閉じる
    await waitFor(() => {
      expect(screen.getByText("追加の引き換えを更新しました")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "キャンセル" })).not.toBeInTheDocument();
  });

  it("closes the edit form on cancel without sending a PUT", async () => {
    renderComponent();

    const editButton = await screen.findByRole("button", { name: "編集" });
    fireEvent.click(editButton);
    await screen.findByRole("button", { name: "キャンセル" });

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "キャンセル" })).not.toBeInTheDocument();
    });
    const putCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit)?.method === "PUT"
    );
    expect(putCalls).toHaveLength(0);
  });

  // Issue #554: パック選択の表示制御（canManage=false + 既存紐付け）は編集フォームでも
  // 追加フォームと同じく disabled になる（枚数変更のみ編集可能なダウングレード耐性）。
  it("disables the pack select in edit mode when canManage=false with an existing binding", async () => {
    renderComponent({ cardPacks: { canManage: false, defaultPackName: null } });

    const editButton = await screen.findByRole("button", { name: "編集" });
    fireEvent.click(editButton);

    const packSelect = (await screen.findByLabelText("編集する引き換えのカードパック")) as HTMLSelectElement;
    expect(packSelect).toBeDisabled();
    expect(packSelect.value).toBe("weapons");
    // 枚数入力はプランに関係なく編集できる
    expect(screen.getByDisplayValue("3")).toBeInTheDocument();
  });
});