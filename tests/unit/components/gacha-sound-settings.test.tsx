import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import GachaSoundSettings from "@/components/GachaSoundSettings";
import { logger } from "@/lib/logger";
import jaMessages from "../../../messages/ja.json";
import type { GachaSoundRule } from "@/lib/gacha-sound-rules";
import type { Json } from "@/types/database";

vi.mock("@/lib/logger");

// Issue #547: GachaSoundSettings.tsx (PR #451 で刷新) には専用のコンポーネント
// テストが存在しなかった。その後の #586 (対象報酬のプルダウン化) と
// #451 レビュー指摘 F5 (保存エコーバックによる再同期) の各フォローアップで
// tests/unit/components/gacha-sound-settings-reward-select.test.tsx と
// tests/unit/components/gacha-sound-settings-save-echo.test.tsx が追加され、
// それぞれの機能に限定した回帰ガードは既に存在する。
//
// 本ファイルは、issue #547 が本来求めていた
//   1. プレミアムゲート(basicプランでのUI無効化)
//   2. レガシー単一URL設定の表示 / currentSoundRulesとの優先順位
//   3. ルール追加(ファイルアップロード経由。ボタンではなく、この形に実装が変更されている)
//   4. ルール削除
//   5. targetType変更(all→rarity。reward方向は#586テストで既にカバー済み)
// に加え、上記2ファイルが未カバーの
//   6. アップロードのバリデーションエラー(サイズ超過・非対応形式・サーバーエラー・レート制限)
//   7. 音声プレビュー再生(再生/停止ボタン)
//   8. MAX_GACHA_SOUND_RULES 上限超過時のサーバー正規化への追従
// を対象にする。

type FetchMock = ReturnType<typeof vi.fn>;

function ruleFixture(overrides: Partial<GachaSoundRule> = {}): GachaSoundRule {
  return {
    id: "rule-1",
    url: "https://example.com/sound.mp3",
    enabled: true,
    label: "効果音",
    targetType: "all",
    rarity: null,
    rewardId: null,
    rewardName: null,
    ...overrides,
  };
}

function mockFetch(
  options: {
    rewards?: unknown[];
    uploadStatus?: number;
    uploadResponseBody?: unknown;
    deleteStatus?: number;
    deleteResponseBody?: unknown;
    settingsStatus?: number;
    settingsResponseBody?: unknown;
  } = {}
): FetchMock {
  const {
    rewards = [],
    uploadStatus = 200,
    uploadResponseBody = { url: "https://example.com/uploaded.mp3" },
    deleteStatus = 200,
    deleteResponseBody = { success: true },
    settingsStatus = 200,
    settingsResponseBody = { success: true },
  } = options;

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url.includes("/api/twitch/rewards")) {
      return new Response(JSON.stringify(rewards), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/api/upload/sound") && method === "DELETE") {
      return new Response(JSON.stringify(deleteResponseBody), {
        status: deleteStatus,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/api/upload/sound")) {
      return new Response(JSON.stringify(uploadResponseBody), {
        status: uploadStatus,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("/api/streamer/settings")) {
      return new Response(JSON.stringify(settingsResponseBody), {
        status: settingsStatus,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function makeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type });
}

// t("form.selectFile")のラベルは<input type="file">とhtmlFor/idで
// 関連付けられていない(コンポーネント側の既存実装)ため、getByLabelTextでは
// 拾えない。type属性で直接取得する。
function getFileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

function renderComponent(props: Partial<React.ComponentProps<typeof GachaSoundSettings>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <GachaSoundSettings
        streamerId="streamer-1"
        plan="support"
        currentSoundUrl={null}
        currentSoundEnabled={false}
        currentSoundRules={[ruleFixture()] as unknown as Json}
        currentRewardId={null}
        currentRewardName={null}
        {...props}
      />
    </NextIntlClientProvider>
  );
}

function settingsRequestBody(fetchMock: FetchMock): { streamerId: string; gachaSoundRules: GachaSoundRule[] } {
  const call = fetchMock.mock.calls.find(([input]) =>
    String(input).includes("/api/streamer/settings")
  );
  if (!call) throw new Error("No /api/streamer/settings call was made");
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("GachaSoundSettings premium gate UI state (Issue #547)", () => {
  it("marks the rule-settings section inert and dimmed for basic-plan (non-premium) users", () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = renderComponent({ plan: "basic" });

    const section = container.querySelector("div.space-y-4") as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.hasAttribute("inert")).toBe(true);
    expect(section.className).toContain("opacity-50");
    expect(
      screen.getByText("複数効果音・ターゲット指定は助力プラン以上の機能です。")
    ).toBeInTheDocument();
  });

  it("keeps the rule-settings section interactive (not inert) for premium (support-plan) users", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderComponent({ plan: "support" });

    // basicと違いプレミアムではマウント時にTwitch報酬取得effectが走る。
    // それを待ってから検証することでact警告を避けつつ、isPremium=trueで
    // 実際に /api/twitch/rewards が呼ばれること自体もあわせて確認する
    // (#586テストの「basicでは呼ばれない」の逆側)。
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("/api/twitch/rewards"))
      ).toBe(true);
    });

    const section = container.querySelector("div.space-y-4") as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.hasAttribute("inert")).toBe(false);
    expect(section.className).not.toContain("opacity-50");
    expect(
      screen.queryByText("複数効果音・ターゲット指定は助力プラン以上の機能です。")
    ).not.toBeInTheDocument();
  });
});

describe("GachaSoundSettings legacy + rule-list rendering (Issue #547)", () => {
  it("renders a legacySoundToRules-derived entry when only the legacy currentSoundUrl/currentSoundEnabled props are given", () => {
    vi.stubGlobal("fetch", mockFetch());
    renderComponent({
      plan: "basic",
      currentSoundUrl: "https://example.com/legacy.mp3",
      currentSoundEnabled: true,
      currentSoundRules: undefined,
    });

    expect(screen.getByDisplayValue("Default sound")).toBeInTheDocument();
    const enableCheckbox = screen.getByLabelText("効果音を有効にする") as HTMLInputElement;
    expect(enableCheckbox.checked).toBe(true);
    expect(screen.getByText("有効")).toBeInTheDocument();
  });

  it("shows the empty-state message when neither a legacy sound nor rules are configured", () => {
    vi.stubGlobal("fetch", mockFetch());
    renderComponent({
      plan: "basic",
      currentSoundUrl: null,
      currentSoundEnabled: false,
      currentSoundRules: undefined,
    });

    expect(screen.getByText("効果音はまだ登録されていません。")).toBeInTheDocument();
    expect(screen.getByText("無効")).toBeInTheDocument();
  });

  it("prefers currentSoundRules over the legacy currentSoundUrl when both are present", () => {
    vi.stubGlobal("fetch", mockFetch());
    renderComponent({
      plan: "basic",
      currentSoundUrl: "https://example.com/legacy.mp3",
      currentSoundEnabled: true,
      currentSoundRules: [
        ruleFixture({ id: "modern-rule", label: "モダンルール", url: "https://example.com/modern.mp3" }),
      ] as unknown as Json,
    });

    expect(screen.getByDisplayValue("モダンルール")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Default sound")).not.toBeInTheDocument();
  });

  it("renders every rule in currentSoundRules as its own row", () => {
    vi.stubGlobal("fetch", mockFetch());
    renderComponent({
      plan: "basic",
      currentSoundRules: [
        ruleFixture({ id: "r1", label: "ルール1" }),
        ruleFixture({ id: "r2", label: "ルール2", url: "https://example.com/r2.mp3" }),
      ] as unknown as Json,
    });

    expect(screen.getByDisplayValue("ルール1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ルール2")).toBeInTheDocument();
  });
});

describe("GachaSoundSettings targetType transition to rarity (Issue #547)", () => {
  it("shows the rarity select (defaulting to common) and saves rarity:'common' when switching from all to rarity", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({ currentSoundRules: [ruleFixture({ targetType: "all" })] as unknown as Json });

    const targetSelect = await screen.findByLabelText("再生条件");
    fireEvent.change(targetSelect, { target: { value: "rarity" } });

    const raritySelect = (await screen.findByLabelText("レアリティ")) as HTMLSelectElement;
    expect(raritySelect.value).toBe("common");

    await waitFor(() => {
      expect(settingsRequestBody(fetchMock).gachaSoundRules[0]).toMatchObject({
        targetType: "rarity",
        rarity: "common",
        rewardId: null,
        rewardName: null,
      });
    });
  });

  it("updates the saved rule when a non-default rarity is chosen", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({
      currentSoundRules: [ruleFixture({ targetType: "rarity", rarity: "common" })] as unknown as Json,
    });

    const raritySelect = await screen.findByLabelText("レアリティ");
    fireEvent.change(raritySelect, { target: { value: "legendary" } });

    await waitFor(() => {
      expect(settingsRequestBody(fetchMock).gachaSoundRules[0].rarity).toBe("legendary");
    });
  });

  it("clears rarity/rewardId/rewardName when switching back to 'all'", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({
      currentSoundRules: [ruleFixture({ targetType: "rarity", rarity: "epic" })] as unknown as Json,
    });

    const targetSelect = await screen.findByLabelText("再生条件");
    fireEvent.change(targetSelect, { target: { value: "all" } });

    await waitFor(() => {
      expect(settingsRequestBody(fetchMock).gachaSoundRules[0]).toMatchObject({
        targetType: "all",
        rarity: null,
        rewardId: null,
        rewardName: null,
      });
    });
    expect(screen.queryByLabelText("レアリティ")).not.toBeInTheDocument();
  });
});

describe("GachaSoundSettings rule addition via file upload (Issue #547)", () => {
  it("appends a new 'all' rule after a successful upload, using the filename (minus extension) as the default label", async () => {
    const fetchMock = mockFetch({ uploadResponseBody: { url: "https://example.com/new-sound.mp3" } });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderComponent({ currentSoundRules: [] as unknown as Json });

    const fileInput = getFileInput(container);
    fireEvent.change(fileInput, { target: { files: [makeFile("Cool Sound Effect.mp3", "audio/mpeg", 1000)] } });

    await waitFor(() => {
      expect(screen.getByText("効果音をアップロードしました")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("Cool Sound Effect")).toBeInTheDocument();

    const body = settingsRequestBody(fetchMock);
    expect(body.gachaSoundRules).toHaveLength(1);
    expect(body.gachaSoundRules[0]).toMatchObject({
      url: "https://example.com/new-sound.mp3",
      targetType: "all",
      enabled: true,
    });
  });

  it("rejects files larger than the 1MB limit without calling the upload endpoint", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderComponent({ currentSoundRules: [] as unknown as Json });

    const fileInput = getFileInput(container);
    fireEvent.change(fileInput, { target: { files: [makeFile("big.mp3", "audio/mpeg", 2 * 1024 * 1024)] } });

    expect(await screen.findByText("ファイルサイズが1MBを超えています")).toBeInTheDocument();
    const uploadCalled = fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/upload/sound")
    );
    expect(uploadCalled).toBe(false);
  });

  it("rejects unsupported file types without calling the upload endpoint", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderComponent({ currentSoundRules: [] as unknown as Json });

    const fileInput = getFileInput(container);
    fireEvent.change(fileInput, { target: { files: [makeFile("notes.txt", "text/plain", 1000)] } });

    expect(
      await screen.findByText("対応していないファイル形式です（MP3, WAV, WebM, OGGのみ）")
    ).toBeInTheDocument();
    const uploadCalled = fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/upload/sound")
    );
    expect(uploadCalled).toBe(false);
  });

  it("shows the server error message when the upload endpoint fails", async () => {
    const fetchMock = mockFetch({
      uploadStatus: 500,
      uploadResponseBody: { error: "ストレージ上限に達しました" },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderComponent({ currentSoundRules: [] as unknown as Json });

    const fileInput = getFileInput(container);
    fireEvent.change(fileInput, { target: { files: [makeFile("a.mp3", "audio/mpeg", 1000)] } });

    expect(await screen.findByText("ストレージ上限に達しました")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("a")).not.toBeInTheDocument();
  });

  it("shows the rate-limit specific message on a 429 response without an error body message", async () => {
    const fetchMock = mockFetch({ uploadStatus: 429, uploadResponseBody: {} });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderComponent({ currentSoundRules: [] as unknown as Json });

    const fileInput = getFileInput(container);
    fireEvent.change(fileInput, { target: { files: [makeFile("a.mp3", "audio/mpeg", 1000)] } });

    expect(
      await screen.findByText("リクエストが多すぎます。しばらく待ってから再試行してください。")
    ).toBeInTheDocument();
  });

  it("resyncs to the server-persisted rule list (drops the optimistic addition) when the server-side MAX_GACHA_SOUND_RULES truncation applies", async () => {
    // MAX_GACHA_SOUND_RULES(50件)自体の上限値検証は
    // tests/unit/gacha-sound-rules.test.ts (normalizeGachaSoundRules) で
    // 既に行われている。ここで検証したいのは、アップロードで楽観的に
    // 追加したルールがサーバー側の正規化で切り捨てられた場合でも、
    // GachaSoundSettings が(#451 F5 の一般的なエコーバック再同期の仕組みを
    // 使って)実際に永続化された配列に正しく追従し、UI上に「保存された体」の
    // まま残らないこと(=ファイルアップロード経路でも再同期が効くこと)。
    const existingRules = [
      ruleFixture({ id: "existing-1", label: "既存1", url: "https://example.com/e1.mp3" }),
      ruleFixture({ id: "existing-2", label: "既存2", url: "https://example.com/e2.mp3" }),
      ruleFixture({ id: "existing-3", label: "既存3", url: "https://example.com/e3.mp3" }),
    ];
    const fetchMock = mockFetch({
      uploadResponseBody: { url: "https://example.com/overflow.mp3" },
      // 上限超過を模して、送信した4件目を含まない既存3件のみが
      // 実際に永続化されたという応答を返す。
      settingsResponseBody: { success: true, gachaSoundRules: existingRules },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderComponent({ currentSoundRules: existingRules as unknown as Json });

    expect(screen.getAllByRole("button", { name: "削除" })).toHaveLength(3);

    const fileInput = getFileInput(container);
    fireEvent.change(fileInput, { target: { files: [makeFile("overflow.mp3", "audio/mpeg", 1000)] } });

    await waitFor(() => {
      expect(screen.getByText("効果音をアップロードしました")).toBeInTheDocument();
    });

    // サーバーが実際に永続化した(=切り捨て後の)3件のままで、
    // クライアントが楽観的に追加した4件目は表示から消える。
    expect(screen.getAllByRole("button", { name: "削除" })).toHaveLength(3);
    expect(screen.queryByDisplayValue("overflow")).not.toBeInTheDocument();
  });
});

describe("GachaSoundSettings rule deletion (Issue #547)", () => {
  it("deletes the sound file and removes the rule from the list on confirm", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({
      currentSoundRules: [ruleFixture({ id: "rule-to-delete", label: "消えるルール" })] as unknown as Json,
    });

    await screen.findByDisplayValue("消えるルール");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue("消えるルール")).not.toBeInTheDocument();
    });
    expect(screen.getByText("効果音を削除しました")).toBeInTheDocument();

    const deleteCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes("/api/upload/sound") && (init as RequestInit | undefined)?.method === "DELETE"
    );
    expect(deleteCall).toBeDefined();
    expect(JSON.parse((deleteCall![1] as RequestInit).body as string)).toEqual({
      url: "https://example.com/sound.mp3",
    });
    expect(settingsRequestBody(fetchMock).gachaSoundRules).toHaveLength(0);
  });

  it("does nothing when the delete confirmation is cancelled", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({
      currentSoundRules: [ruleFixture({ label: "残るルール" })] as unknown as Json,
    });

    await screen.findByDisplayValue("残るルール");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    expect(screen.getByDisplayValue("残るルール")).toBeInTheDocument();
    const deleteCalled = fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/upload/sound")
    );
    expect(deleteCalled).toBe(false);
  });

  it("shows an error message and keeps the rule when the delete request fails", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const fetchMock = mockFetch({
      deleteStatus: 500,
      deleteResponseBody: { error: "削除できませんでした(テスト)" },
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent({
      currentSoundRules: [ruleFixture({ label: "残存ルール" })] as unknown as Json,
    });

    await screen.findByDisplayValue("残存ルール");
    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    expect(await screen.findByText("削除できませんでした(テスト)")).toBeInTheDocument();
    expect(screen.getByDisplayValue("残存ルール")).toBeInTheDocument();
  });
});

describe("GachaSoundSettings audio preview playback (Issue #547)", () => {
  it("resets playback position and calls play() when the 再生 button is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const { container } = renderComponent({ currentSoundRules: [ruleFixture()] as unknown as Json });
    await screen.findByRole("button", { name: "再生" });

    const audio = container.querySelector("audio") as HTMLAudioElement;
    audio.currentTime = 5;

    fireEvent.click(screen.getByRole("button", { name: "再生" }));

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
  });

  it("pauses and resets playback position when the 停止 button is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, "pause");
    const { container } = renderComponent({ currentSoundRules: [ruleFixture()] as unknown as Json });
    await screen.findByRole("button", { name: "停止" });

    const audio = container.querySelector("audio") as HTMLAudioElement;
    audio.currentTime = 7;

    fireEvent.click(screen.getByRole("button", { name: "停止" }));

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
  });

  it("logs via logger.error instead of throwing when play() rejects (e.g. autoplay blocked)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("autoplay blocked"));
    renderComponent({ currentSoundRules: [ruleFixture()] as unknown as Json });
    await screen.findByRole("button", { name: "再生" });

    fireEvent.click(screen.getByRole("button", { name: "再生" }));

    await waitFor(() => {
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith("Audio play error:", expect.any(Error));
    });
  });
});
