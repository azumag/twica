import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChannelPointSettings from "@/components/ChannelPointSettings";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// Issue #393: verify the card-pack dropdowns are actually populated.
// Regression guard for the original PR #448 defect where fetchCollectionNames
// was never invoked (C1) and hit the wrong endpoint/shape (C2).

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(collections: string[] = ["characters", "weapons"]): FetchMock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/cards/collections")) {
      return new Response(JSON.stringify({ collections }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/twitch/channel-point-bootstrap")) {
      return new Response(
        JSON.stringify({
          hasRequiredScope: true,
          requiresReauth: false,
          rewards: [{ id: "main-reward", title: "Main", cost: 100, is_enabled: true }],
          subscriptions: [],
          additionalRewards: [],
          // Issue #555: the additional-reward section (and its own pack select)
          // only renders when eventSubStatus === "active" — set it here so the
          // new "default pack only" option tests can see BOTH selects.
          eventSubStatus: "active",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // Any other endpoint: respond with a benign empty payload.
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

describe("ChannelPointSettings card pack dropdowns", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches /api/cards/collections with the streamerId on mount", async () => {
    renderComponent();

    await waitFor(() => {
      const called = fetchMock.mock.calls.some(([input]) => {
        const url = typeof input === "string" ? input : String(input);
        return url.includes("/api/cards/collections?streamerId=streamer-1");
      });
      expect(called).toBe(true);
    });
  });

  // Issue #1994: パック選択は複数チェックボックス群（role=group）になった。
  it("renders the fetched pack names as checkboxes", async () => {
    renderComponent();

    await waitFor(() => {
      // Both the main-reward and additional-reward pack groups list the packs,
      // so each name appears at least once as a checkbox label.
      expect(screen.getAllByRole("checkbox", { name: "weapons" }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("checkbox", { name: "characters" }).length).toBeGreaterThan(0);
    });
  });

  // Issue #393再設計: パック選択はもうゲート対象外(新規登録はパック管理
  // モーダル側でのみ発生する)。選択肢は常に有効(disabledではない)。
  it("does not disable pack checkboxes (selection is never gated here)", async () => {
    renderComponent();

    await waitFor(() => {
      const boxes = screen.getAllByRole("checkbox", { name: "weapons" }) as HTMLInputElement[];
      expect(boxes.length).toBeGreaterThan(0);
      boxes.forEach((box) => expect(box.disabled).toBe(false));
    });
  });

  // Issue #555: a fixed "default pack only" option (collection_name IS NULL)
  // must appear alongside "all cards" and the registered pack names, in both
  // the main-reward and additional-reward pack groups.
  it('renders a "default pack only" checkbox in both pack groups', async () => {
    renderComponent();

    await waitFor(() => {
      const boxes = screen.getAllByRole("checkbox", { name: "デフォルトパック（未分類のカードのみ）" }) as HTMLInputElement[];
      expect(boxes.length).toBe(2);
      boxes.forEach((box) => {
        expect(box.disabled).toBe(false);
      });
    });
  });

  // Regression guard: DEFAULT_PACK_SENTINEL is never a registered pack name
  // (it's reserved), so the "orphaned/missing pack" fallback option must not
  // ALSO render a duplicate <option value="__default__"> labeled "missing" —
  // that would create two options sharing one value in the same <select>.
  it('does not render a duplicate "missing pack" option for the default-pack sentinel', async () => {
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <ChannelPointSettings
          streamerId="streamer-1"
          currentRewardId="main-reward"
          currentRewardName="Main"
          currentCollectionName="__default__"
        />
      </NextIntlClientProvider>
    );

    await waitFor(() => {
      const defaultBoxes = screen.getAllByRole("checkbox", { name: "デフォルトパック（未分類のカードのみ）" });
      expect(defaultBoxes.length).toBe(2);
    });
    expect(screen.queryByText(/登録解除済み/)).not.toBeInTheDocument();
  });

  // Issue #555 (review MINOR): a real pack literally named "__default__" could
  // have been registered BEFORE the reserved-name guard existed. If the API
  // response still contains such legacy names, fetchCollections must filter
  // them out defensively — otherwise the fixed DEFAULT_PACK_SENTINEL option and
  // the legacy pack would render duplicate <option>s sharing one value in the
  // same <select>, making the legacy pack unselectable.
  it("filters reserved (`__`-prefixed) names out of the API response so options never duplicate", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch(["characters", "weapons", "__default__", "__legacy"]));

    renderComponent();

    await waitFor(() => {
      // Normal packs render as usual (main + additional group = 2 each).
      expect(screen.getAllByRole("checkbox", { name: "weapons" }).length).toBe(2);
    });
    // Exactly the two FIXED default-pack checkboxes remain — no third/fourth
    // checkbox coming from the legacy "__default__" entry in the response.
    const defaultBoxes = screen.getAllByRole("checkbox", { name: "デフォルトパック（未分類のカードのみ）" }) as HTMLInputElement[];
    expect(defaultBoxes.length).toBe(2);
    // The raw reserved names never appear as checkbox labels.
    expect(screen.queryByRole("checkbox", { name: "__default__" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "__legacy" })).not.toBeInTheDocument();
  });
});

// Issue #554: cardPacks prop controls whether the pack selects are shown,
// shown-disabled, or shown-enabled, depending on plan (canManage) and
// whether a binding already exists (downgrade-safety: never silently drop it).
describe("ChannelPointSettings cardPacks display control (Issue #554)", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("canManage=false + no current binding: hides both pack selects and shows the upsell hint", async () => {
    renderComponent({ cardPacks: { canManage: false, defaultPackName: null } });

    await waitFor(() => {
      expect(screen.getAllByText("カードパック（支援プラン限定機能）").length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("group", { name: "引き換え対象のカードパック" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "追加の引き換え対象のカードパック" })).not.toBeInTheDocument();
  });

  it("canManage=false + an existing main-reward binding: shows the select but disabled, plus the upsell hint", async () => {
    renderComponent({
      currentCollectionName: "weapons",
      cardPacks: { canManage: false, defaultPackName: null },
    });

    await waitFor(() => {
      const group = screen.getByRole("group", { name: "引き換え対象のカードパック" });
      const boxes = within(group).getAllByRole("checkbox") as HTMLInputElement[];
      boxes.forEach((box) => expect(box.disabled).toBe(true));
      expect(within(group).getByRole("checkbox", { name: "weapons" })).toBeChecked();
    });
    expect(screen.getAllByText("カードパック（支援プラン限定機能）").length).toBeGreaterThan(0);
  });

  it("canManage=true + zero registered packs: shows the (always-enabled) select plus a registration hint", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockFetch([]));
    renderComponent({ cardPacks: { canManage: true, defaultPackName: null } });

    await waitFor(() => {
      const group = screen.getByRole("group", { name: "引き換え対象のカードパック" });
      within(group).getAllByRole("checkbox").forEach((box) =>
        expect(box).not.toBeDisabled()
      );
    });
    expect(
      screen.getAllByText("パック名はカード管理の「パック管理」から登録できます").length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("カードパック（支援プラン限定機能）")).not.toBeInTheDocument();
  });

  it("canManage=true + packs registered: behaves exactly like the legacy (cardPacks-unset) display", async () => {
    renderComponent({ cardPacks: { canManage: true, defaultPackName: null } });

    await waitFor(() => {
      const group = screen.getByRole("group", { name: "引き換え対象のカードパック" });
      within(group).getAllByRole("checkbox").forEach((box) =>
        expect(box).not.toBeDisabled()
      );
    });
    expect(screen.queryByText("カードパック（支援プラン限定機能）")).not.toBeInTheDocument();
    expect(screen.queryByText("パック名はカード管理の「パック管理」から登録できます")).not.toBeInTheDocument();
  });

  it("parameterizes the default-pack option label with the streamer's custom display name", async () => {
    renderComponent({ cardPacks: { canManage: true, defaultPackName: "オリジナルカード" } });

    await waitFor(() => {
      const boxes = screen.getAllByRole("checkbox", { name: "オリジナルカード（未分類のカードのみ）" });
      expect(boxes.length).toBe(2);
    });
    expect(screen.queryByText("デフォルトパック（未分類のカードのみ）")).not.toBeInTheDocument();
  });
});

// Issue #1998 (指摘2): 保存成功メッセージの優先順位。
// settings API が channelPointCollectionNamesSkippedDeployWindow=true を返した
// とき、EventSub 応答の raid warning / message より「反映待ち」文言を優先して
// 表示することを確認する（旧順序では warning/message が先に評価され、
// 反映待ち通知が覆い隠され得た）。
describe("ChannelPointSettings save message priority (Issue #1998)", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the deploy-window pending message even when EventSub returns a message and raid warning", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/streamer/settings" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ success: true, channelPointCollectionNamesSkippedDeployWindow: true }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "/api/twitch/eventsub/subscribe" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            success: true,
            message: "EVENTSUB_MESSAGE_MARKER",
            raidSubscription: { status: "error", warning: "RAID_WARNING_MARKER" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      // フォールバックは共通の mockFetch に委譲する。FetchMock（vi.fn の
      // Mock 型）は型上直接呼び出せないため、fetch のシグネチャにキャストする。
      return (mockFetch() as unknown as typeof fetch)(input, init);
    });

    renderComponent();

    const saveButton = await screen.findByRole("button", { name: "保存 & EventSub登録" });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(
        screen.getByText("保存しました（パック割り当ての一部は反映待ちです）")
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("EVENTSUB_MESSAGE_MARKER")).not.toBeInTheDocument();
    // raid warning は別スロット（raidEventSubWarning）で表示されるため、
    // message スロットを奪わないことだけを検証する。
  });
});

// メイン報酬のパック保存は「初期値から変わったときだけ」channelPointCollectionNames
// を送る（サーバーはキー無し=変更なし、[]=全カードと解釈する）。比較基準が props 由来の
// 初期値のまま固定だと、保存成功後に初期値へ戻す操作が「未変更」と誤判定されて
// 送信が省略され、画面は「保存しました」なのに DB が古い値のまま残る。
// 保存成功のたびに基準を「実際に DB に残る実効値」へ更新することを確認する。
describe("ChannelPointSettings main pack save baseline", () => {
  let fetchMock: FetchMock;
  let settingsBodies: Array<Record<string, unknown>>;

  // settings POST の応答だけ差し替えられるようにする。EventSub は成功を返す。
  function installFetch(settingsResponses: Array<Record<string, unknown>> = []) {
    settingsBodies = [];
    let settingsCall = 0;
    fetchMock = mockFetch();
    const fallback = mockFetch() as unknown as typeof fetch;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/streamer/settings" && init?.method === "POST") {
        settingsBodies.push(JSON.parse(String(init.body)));
        const payload = settingsResponses[settingsCall++] ?? { success: true };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/twitch/eventsub/subscribe" && init?.method === "POST") {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fallback(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  // メイン報酬側のパックグループ内のチェックボックスを返す。
  // 追加報酬側は「追加の引き換え対象のカードパック」で名前が異なるため完全一致で区別できる。
  const mainPack = (name: string) =>
    within(screen.getByRole("group", { name: "引き換え対象のカードパック" })).getByRole("checkbox", { name });

  // 保存ボタンを押し、その保存が完了する（ボタンが再び有効になる）まで待つ。
  async function save(expectedPosts: number) {
    const saveButton = await screen.findByRole("button", { name: "保存 & EventSub登録" });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    fireEvent.click(saveButton);
    await waitFor(() => expect(settingsBodies.length).toBe(expectedPosts));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存 & EventSub登録" })).not.toBeDisabled()
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resends [] after saving [weapons] and then unchecking it (initial [] baseline must not stick)", async () => {
    installFetch();
    renderComponent();
    await waitFor(() => expect(mainPack("weapons")).toBeInTheDocument());

    fireEvent.click(mainPack("weapons"));
    await save(1);
    expect(settingsBodies[0].channelPointCollectionNames).toEqual(["weapons"]);

    fireEvent.click(mainPack("weapons"));
    await save(2);
    expect(settingsBodies[1]).toHaveProperty("channelPointCollectionNames", []);
  });

  it("resends [weapons] after saving [] and then re-checking it", async () => {
    installFetch();
    renderComponent({ currentCollectionNames: ["weapons"] });
    await waitFor(() => expect(mainPack("weapons")).toBeChecked());

    fireEvent.click(mainPack("weapons"));
    await save(1);
    expect(settingsBodies[0]).toHaveProperty("channelPointCollectionNames", []);

    fireEvent.click(mainPack("weapons"));
    await save(2);
    expect(settingsBodies[1].channelPointCollectionNames).toEqual(["weapons"]);
  });

  it("still omits channelPointCollectionNames when the selection is unchanged (twice in a row)", async () => {
    installFetch();
    renderComponent({ currentCollectionNames: ["weapons"] });
    await waitFor(() => expect(mainPack("weapons")).toBeChecked());

    await save(1);
    await save(2);
    expect(settingsBodies[0]).not.toHaveProperty("channelPointCollectionNames");
    expect(settingsBodies[1]).not.toHaveProperty("channelPointCollectionNames");
  });

  it("uses only the first name as baseline when the deploy window stripped the rest, so the full array is resent", async () => {
    // 1回目: 列未適用のデプロイ窓で先頭1件(characters)しか保存されなかった応答。
    installFetch([{ success: true, channelPointCollectionNamesSkippedDeployWindow: true }, { success: true }, { success: true }]);
    renderComponent({ currentCollectionNames: ["weapons"] });
    await waitFor(() => expect(mainPack("weapons")).toBeChecked());

    // ["weapons"] → ["characters","weapons"]（先頭が旧列ミラーになる並び）にして保存。
    fireEvent.click(mainPack("weapons"));
    fireEvent.click(mainPack("characters"));
    fireEvent.click(mainPack("weapons"));
    await save(1);
    expect(settingsBodies[0].channelPointCollectionNames).toEqual(["characters", "weapons"]);

    // 選択を変えずに再保存 → 基準は先頭1件["characters"]なので全体が再送される。
    await save(2);
    expect(settingsBodies[1].channelPointCollectionNames).toEqual(["characters", "weapons"]);

    // characters を外して ["weapons"]（= props の初期値と同じ）にして保存。
    // DB に実際に残っているのは ["characters"] なので、初期値と等しくても送信が必要。
    // 基準が props 初期値のままだと、ここが「未変更」と誤判定されて省略される。
    fireEvent.click(mainPack("characters"));
    await save(3);
    expect(settingsBodies[2].channelPointCollectionNames).toEqual(["weapons"]);
  });
});
