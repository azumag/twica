import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// 追加報酬の編集機能（パック変更・枚数変更）の回帰ガード。
// - 一覧の「編集」ボタンでインラインフォームが開く
// - 更新すると PUT /api/streamer/additional-rewards が呼ばれ、一覧が再取得される
// - キャンセルでフォームが閉じる

type FetchMock = ReturnType<typeof vi.fn>;

const DEFAULT_ADDITIONAL_REWARDS = [
  {
    id: "ar-1",
    reward_id: "extra-reward",
    reward_name: "Extra",
    draw_count: 3,
    is_raid_limited: false,
    collection_name: "weapons",
    created_at: "2026-01-01T00:00:00.000Z",
  },
];

function mockFetch(
  additionalRewards: unknown[] = DEFAULT_ADDITIONAL_REWARDS,
  overrides: { putStatus?: number; putBody?: unknown } = {}
): FetchMock {
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
          additionalRewards,
          eventSubStatus: "active",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/streamer/additional-rewards") && method === "GET") {
      return new Response(JSON.stringify(additionalRewards), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/streamer/additional-rewards") && method === "PUT") {
      return new Response(JSON.stringify(overrides.putBody ?? { success: true }), {
        status: overrides.putStatus ?? 200,
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

function renderComponent(
  props: Partial<React.ComponentProps<typeof ChannelPointSettings>> = {},
  mode: "off" | "read_only" = "off"
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={{ mode } as unknown as MaintenanceStatusResponse}>
        <ChannelPointSettings
          streamerId="streamer-1"
          currentRewardId="main-reward"
          currentRewardName="Main"
          currentCollectionName={null}
          {...props}
        />
      </MaintenanceStatusContext.Provider>
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

    const editButton = await screen.findByRole("button", { name: "パック・枚数を編集" });
    fireEvent.click(editButton);

// 編集フォームが表示され、パック選択に現在値（weapons）がプリフィルされる
    const packSelect = (await screen.findByLabelText("編集する引き換えのカードパック")) as HTMLSelectElement;
    expect(packSelect.value).toBe("weapons");
    // 枚数入力も現在値（3連）がプリフィルされる（追加フォームと重複しない専用ラベル）
    const drawCountInput = screen.getByLabelText("一度に排出する枚数（編集）") as HTMLInputElement;
    expect(drawCountInput.value).toBe("3");
    expect(screen.getByRole("button", { name: "変更を保存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "キャンセル" })).toBeInTheDocument();
  });

  it("sends a PUT with the new collection and draw count, then closes the form", async () => {
    renderComponent();

    const editButton = await screen.findByRole("button", { name: "パック・枚数を編集" });
    fireEvent.click(editButton);

    const packSelect = (await screen.findByLabelText("編集する引き換えのカードパック")) as HTMLSelectElement;
    fireEvent.change(packSelect, { target: { value: "characters" } });
    const drawCountInput = screen.getByLabelText("一度に排出する枚数（編集）") as HTMLInputElement;
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

    const editButton = await screen.findByRole("button", { name: "パック・枚数を編集" });
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

    const editButton = await screen.findByRole("button", { name: "パック・枚数を編集" });
    fireEvent.click(editButton);

    const packSelect = (await screen.findByLabelText("編集する引き換えのカードパック")) as HTMLSelectElement;
    expect(packSelect).toBeDisabled();
    expect(packSelect.value).toBe("weapons");
    // 枚数入力はプランに関係なく編集できる
    expect(screen.getByLabelText("一度に排出する枚数（編集）")).toBeInTheDocument();
  });

  // 編集中の行の「編集」再クリックで未保存入力が無告知リセットされないこと。
  it("disables the edit button of the row being edited (no silent reset)", async () => {
    renderComponent();

    const editButton = await screen.findByRole("button", { name: "パック・枚数を編集" });
    fireEvent.click(editButton);
    // 編集フォームが開いたら、同じ行の編集ボタンは disabled になる
    await screen.findByLabelText("編集する引き換えのカードパック");
    expect(screen.getByRole("button", { name: "パック・枚数を編集" })).toBeDisabled();
  });

  // メンテナンスモード中は編集ボタン自体が disabled になる
  // （フォームを開いてから保存できない不親切な導線にしない）。
  it("disables the edit button itself during maintenance mode", async () => {
    renderComponent({}, "read_only");

    const editButton = await screen.findByRole("button", { name: "パック・枚数を編集" });
    expect(editButton).toBeDisabled();
  });

  // PUT が 404（別タブで削除済み）を返したら、存在しない行の編集フォームを
  // 閉じて一覧を再取得する（手動リロードを強いる表示にしない）。
  it("closes the edit form and refetches the list when PUT returns 404", async () => {
    const notFoundMock = mockFetch(undefined, {
      putStatus: 404,
      putBody: { error: "この追加の引き換えは既に削除されています。設定を再読み込みしてください" },
    });
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", notFoundMock);
    renderComponent();

    const editButton = await screen.findByRole("button", { name: "パック・枚数を編集" });
    fireEvent.click(editButton);
    await screen.findByLabelText("編集する引き換えのカードパック");

    fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));

    await waitFor(() => {
      expect(
        screen.getByText("この追加の引き換えは既に削除されています。設定を再読み込みしてください")
      ).toBeInTheDocument();
    });
    // 編集フォームは閉じる
    expect(screen.queryByRole("button", { name: "キャンセル" })).not.toBeInTheDocument();
    // 一覧が再取得される（fetchAdditionalRewards は method 未指定 = GET）
    const getCalls = notFoundMock.mock.calls.filter(
      ([input, init]) =>
        String(input).includes("/api/streamer/additional-rewards") &&
        ((init as RequestInit)?.method ?? "GET") === "GET"
    );
    expect(getCalls.length).toBeGreaterThan(0);
  });

  // 別の行の「編集」を押したとき、編集中の未保存入力が無告知で破棄されないこと。
  it("confirms before switching edit targets with unsaved changes; cancel keeps the current edit", async () => {
    const secondReward = {
      id: "ar-2",
      reward_id: "extra-reward-2",
      reward_name: "Extra 2",
      draw_count: 1,
      is_raid_limited: false,
      collection_name: "characters",
      created_at: "2026-01-02T00:00:00.000Z",
    };
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch([...DEFAULT_ADDITIONAL_REWARDS, secondReward]));
    const confirmMock = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmMock);
    renderComponent();

    const editButtons = await screen.findAllByRole("button", { name: "パック・枚数を編集" });
    fireEvent.click(editButtons[0]);
    // 未保存の変更を作る
    const packSelect = (await screen.findByLabelText("編集する引き換えのカードパック")) as HTMLSelectElement;
    fireEvent.change(packSelect, { target: { value: "characters" } });

    fireEvent.click(editButtons[1]);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    // キャンセルしたので 1 件目の編集フォームが残る
    expect(screen.getByLabelText("編集する引き換えのカードパック")).toBeInTheDocument();
  });

  it("switches to the other row's edit form when the discard is confirmed", async () => {
    const secondReward = {
      id: "ar-2",
      reward_id: "extra-reward-2",
      reward_name: "Extra 2",
      draw_count: 1,
      is_raid_limited: false,
      collection_name: "characters",
      created_at: "2026-01-02T00:00:00.000Z",
    };
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch([...DEFAULT_ADDITIONAL_REWARDS, secondReward]));
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    renderComponent();

    const editButtons = await screen.findAllByRole("button", { name: "パック・枚数を編集" });
    fireEvent.click(editButtons[0]);
    const packSelect = (await screen.findByLabelText("編集する引き換えのカードパック")) as HTMLSelectElement;
    fireEvent.change(packSelect, { target: { value: "characters" } });

    fireEvent.click(editButtons[1]);

    // 2 件目の編集フォームに切り替わり、characters がプリフィルされる
    await waitFor(() => {
      const switched = screen.getByLabelText("編集する引き換えのカードパック") as HTMLSelectElement;
      expect(switched.value).toBe("characters");
    });
  });

  // 入力値を変えずに別の行へ切り替える場合は confirm を出さない（文言と実態の一致）。
  it("does not confirm when switching without unsaved changes", async () => {
    const secondReward = {
      id: "ar-2",
      reward_id: "extra-reward-2",
      reward_name: "Extra 2",
      draw_count: 1,
      is_raid_limited: false,
      collection_name: "characters",
      created_at: "2026-01-02T00:00:00.000Z",
    };
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch([...DEFAULT_ADDITIONAL_REWARDS, secondReward]));
    const confirmMock = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmMock);
    renderComponent();

    const editButtons = await screen.findAllByRole("button", { name: "パック・枚数を編集" });
    fireEvent.click(editButtons[0]);
    await screen.findByLabelText("編集する引き換えのカードパック");

    fireEvent.click(editButtons[1]);

    expect(confirmMock).not.toHaveBeenCalled();
    // 2 件目の編集フォームに切り替わっている
    await waitFor(() => {
      expect(screen.getByLabelText("編集する引き換えのカードパック")).toBeInTheDocument();
    });
  });

  // 保存中に他行の編集へ移っても、保存完了で開いているフォームを閉じない。
  it("keeps the newly opened form when save completes after switching rows", async () => {
    const secondReward = {
      id: "ar-2",
      reward_id: "extra-reward-2",
      reward_name: "Extra 2",
      draw_count: 1,
      is_raid_limited: false,
      collection_name: "characters",
      created_at: "2026-01-02T00:00:00.000Z",
    };
    vi.unstubAllGlobals();
    const baseMock = mockFetch([...DEFAULT_ADDITIONAL_REWARDS, secondReward]);
    let resolvePut!: (response: Response) => void;
    const gatingMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/streamer/additional-rewards") && (init?.method ?? "GET") === "PUT") {
        return new Promise<Response>((resolve) => {
          resolvePut = resolve;
        });
      }
      return (baseMock as ReturnType<typeof vi.fn>)(input, init);
    });
    vi.stubGlobal("fetch", gatingMock);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    renderComponent();

    const editButtons = await screen.findAllByRole("button", { name: "パック・枚数を編集" });
    // 1 件目の編集を開いて保存を開始する
    fireEvent.click(editButtons[0]);
    await screen.findByLabelText("編集する引き換えのカードパック");
    fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));
    // PUT 実行中に 2 件目の編集へ移る（confirm なしで開けること）
    const secondButtons = screen.getAllByRole("button", { name: "パック・枚数を編集" });
    expect(secondButtons[1]).not.toBeDisabled();
    fireEvent.click(secondButtons[1]);
    const switched = (await screen.findByLabelText("編集する引き換えのカードパック")) as HTMLSelectElement;
    expect(switched.value).toBe("characters");
    // PUT が完了しても 2 件目のフォームが残る
    resolvePut(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    await waitFor(() => {
      expect(screen.getByText("追加の引き換えを更新しました")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "キャンセル" })).toBeInTheDocument();
    expect(
      (screen.getByLabelText("編集する引き換えのカードパック") as HTMLSelectElement).value
    ).toBe("characters");
  });
});