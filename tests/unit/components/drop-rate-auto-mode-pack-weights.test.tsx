import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import DropRateAutoModeContent from "@/components/DropRateAutoModeContent";
import jaMessages from "../../../messages/ja.json";
import { baseCard } from "../../utils/card-manager-test-helpers";

vi.mock("@/lib/logger");

// Issue #580(#576 フェーズ3): 配分スコープ切替(全体/パック別)とパック別
// レアリティ配分エディタのテスト。DropRateSettingsModal を経由せず、
// DropRateAutoModeContent を直接レンダリングする(GachaSoundSettings のテストと
// 同じ方針。isOpen ゲートは親のDropRateSettingsModal側の責務のため不要)。

type Props = React.ComponentProps<typeof DropRateAutoModeContent>;

function renderContent(overrides: Partial<Props> = {}) {
  const defaultProps: Props = {
    cards: [],
    streamerId: "streamer-1",
    rarityWeights: { common: 70, rare: 20, epic: 8, legendary: 2 },
    customRarities: [],
    cardPackNames: [],
    defaultPackName: null,
    rarityWeightsScope: "global",
    packRarityWeights: null,
    onPackWeightsApply: vi.fn(),
    onCardsSave: vi.fn(),
    onRarityWeightsApply: vi.fn(),
    onSwitchToManualMode: vi.fn(),
    onClose: vi.fn(),
  };
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <DropRateAutoModeContent {...defaultProps} {...overrides} />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DropRateAutoModeContent scope toggle visibility", () => {
  it("does not render the scope toggle when the streamer has no registered packs", () => {
    renderContent({ cardPackNames: [] });
    expect(screen.queryByText("配分スコープ")).not.toBeInTheDocument();
  });

  it("renders the scope toggle (defaulting to the current scope prop) when packs exist", () => {
    renderContent({ cardPackNames: ["武器パック"], rarityWeightsScope: "global" });
    expect(screen.getByText("配分スコープ")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "全体で1つの配分" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(screen.getByRole("radio", { name: "パック別の配分" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
  });
});

describe("DropRateAutoModeContent per-pack editor: inherit -> 専用設定 -> 継承に戻す", () => {
  it("shows the pack selector and a read-only inherited baseline for a pack with no override", () => {
    renderContent({ cardPackNames: ["武器パック"] });

    fireEvent.click(screen.getByRole("radio", { name: "パック別の配分" }));

    const select = document.querySelector("#drop-rate-pack-select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(within(select).getByRole("option", { name: "デフォルト" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "武器パック" })).toBeInTheDocument();

    expect(screen.getByText("グローバル設定を継承中")).toBeInTheDocument();
    expect(screen.getByText("このパック専用に設定する")).toBeInTheDocument();
    // 継承中は読み取り専用表示のため編集用の入力は存在しない
    expect(document.querySelectorAll('input[type="range"]').length).toBe(0);
    expect(document.querySelectorAll('input[type="number"]').length).toBe(0);
  });

  it("copies the global values into an editable per-pack entry, then reverts back to inheriting", () => {
    renderContent({ cardPackNames: ["武器パック"] });

    fireEvent.click(screen.getByRole("radio", { name: "パック別の配分" }));
    fireEvent.click(screen.getByText("このパック専用に設定する"));

    // グローバル値(70+20+8+2=100)がそのままコピーされ、編集可能になる
    expect(screen.getByText("継承に戻す")).toBeInTheDocument();
    expect(document.querySelectorAll('input[type="number"]').length).toBe(4);
    expect(screen.getByText("100.0%")).toBeInTheDocument();

    fireEvent.click(screen.getByText("継承に戻す"));

    expect(screen.getByText("グローバル設定を継承中")).toBeInTheDocument();
    expect(screen.getByText("このパック専用に設定する")).toBeInTheDocument();
    expect(document.querySelectorAll('input[type="number"]').length).toBe(0);
  });

  it("preserves edits to a pack that is not currently selected when switching packs", () => {
    renderContent({ cardPackNames: ["武器パック", "防具パック"] });

    fireEvent.click(screen.getByRole("radio", { name: "パック別の配分" }));

    // デフォルト(初期選択)から武器パックへ切り替えてから専用設定にする
    const select = document.querySelector("#drop-rate-pack-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "武器パック" } });
    fireEvent.click(screen.getByText("このパック専用に設定する"));

    // 武器パックのコモンを変更
    const numberInputs = document.querySelectorAll('input[type="number"]');
    fireEvent.change(numberInputs[0], { target: { value: "60" } });

    // 別パックへ切り替え → まだ継承中のはず
    fireEvent.change(select, { target: { value: "防具パック" } });
    expect(screen.getByText("グローバル設定を継承中")).toBeInTheDocument();

    // 武器パックへ戻すと編集内容が維持されている
    fireEvent.change(select, { target: { value: "武器パック" } });
    const restoredInputs = document.querySelectorAll('input[type="number"]');
    expect((restoredInputs[0] as HTMLInputElement).value).toBe("60");
  });
});

describe("DropRateAutoModeContent per-pack sum-100 validation", () => {
  it("shows a warning and disables save when a per-pack entry does not total 100%", () => {
    renderContent({ cardPackNames: ["武器パック"] });

    fireEvent.click(screen.getByRole("radio", { name: "パック別の配分" }));
    fireEvent.click(screen.getByText("このパック専用に設定する"));

    const numberInputs = document.querySelectorAll('input[type="number"]');
    // common を 70 -> 50 に変更(合計が80%になり不正)
    fireEvent.change(numberInputs[0], { target: { value: "50" } });

    expect(screen.getByText("合計が100%ではありません")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存して適用" })).toBeDisabled();
  });
});

describe("DropRateAutoModeContent save payload + deploy-window handling (Issue #580)", () => {
  it("sends rarityWeights + rarityWeightsScope + the full packRarityWeights map together, and resyncs from the echo", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          success: true,
          recalculatedCards: [],
          packRarityWeights: { 武器パック: { common: 70, rare: 20, epic: 8, legendary: 2 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const onPackWeightsApply = vi.fn();
    renderContent({ cardPackNames: ["武器パック"], onPackWeightsApply });

    fireEvent.click(screen.getByRole("radio", { name: "パック別の配分" }));
    const select = document.querySelector("#drop-rate-pack-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "武器パック" } });
    fireEvent.click(screen.getByText("このパック専用に設定する"));
    fireEvent.click(screen.getByRole("button", { name: "保存して適用" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/streamer/settings");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body).toEqual({
      streamerId: "streamer-1",
      rarityWeights: { common: 70, rare: 20, epic: 8, legendary: 2 },
      rarityWeightsScope: "per_pack",
      packRarityWeights: { 武器パック: { common: 70, rare: 20, epic: 8, legendary: 2 } },
    });

    await waitFor(() => {
      expect(onPackWeightsApply).toHaveBeenCalledWith("per_pack", {
        武器パック: { common: 70, rare: 20, epic: 8, legendary: 2 },
      });
    });
  });

  it("does not send scope/pack fields for streamers with zero registered packs", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ success: true, recalculatedCards: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    renderContent({ cardPackNames: [] });

    // レアリティ別設定を変更して保存可能にする
    const numberInputs = document.querySelectorAll('input[type="number"]');
    fireEvent.change(numberInputs[0], { target: { value: "60" } });
    fireEvent.change(numberInputs[1], { target: { value: "30" } });

    fireEvent.click(screen.getByRole("button", { name: "保存して適用" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body).toEqual({
      streamerId: "streamer-1",
      rarityWeights: { common: 60, rare: 30, epic: 8, legendary: 2 },
    });
  });

  it("surfaces a deploy-window message and does not resync when the scope/pack columns are not deployed yet", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            recalculatedCards: [],
            rarityWeightsScopeSkippedDeployWindow: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const onPackWeightsApply = vi.fn();
    renderContent({ cardPackNames: ["武器パック"], onPackWeightsApply });

    fireEvent.click(screen.getByRole("radio", { name: "パック別の配分" }));
    fireEvent.click(screen.getByRole("button", { name: "保存して適用" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "配分スコープ/パック別設定の機能が準備中のため、変更は保存できませんでした。しばらくしてから再度お試しください。"
        )
      ).toBeInTheDocument();
    });
    expect(onPackWeightsApply).not.toHaveBeenCalled();
    // 自己レビューで発見(F1相当): デプロイ窓エラーと同時に「保存しました」の
    // 成功メッセージが出ると、rarityWeightsは保存済みでもスコープ/パック別
    // 設定は反映されていないという事実が矛盾するメッセージに埋もれてしまう。
    // GachaSoundSettings.saveRules と同様、この失敗ケースでは成功メッセージを
    // 一切出さないことを保証する。
    expect(screen.queryByText("確率を再計算しました")).not.toBeInTheDocument();
  });
});

describe("DropRateAutoModeContent per-card save guards unsaved pack-weight drafts (Issue #580)", () => {
  it("confirms before discarding an unsaved per-pack draft when saving from the per-card tab", async () => {
    // 自己レビューで発見: 「カードごとの調整」タブの保存(handlePerCardSave)は
    // 保存完了後にモーダルを閉じるため、レアリティタブの未保存変更(グローバル
    // 配分に加えてスコープ切替/パック別配分も含む)を破棄してしまう。
    // rarityHasChanges だけを見ていると、パック別配分だけを編集した状態では
    // 確認なしに破棄されてしまう(hasAnyChangesは正しくscopeOrPackHasChangesを
    // 含めているのに、handlePerCardSaveだけ旧来のチェックのままだった)。
    const confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const card = baseCard({ id: "c1", name: "Card1", rarity: "common", intra_rarity_weight: 1 });
    renderContent({ cards: [card], cardPackNames: ["武器パック"] });

    // パック別配分に切り替えて専用設定にする(rarityHasChangesはfalseのまま、
    // scopeOrPackHasChangesだけがtrueになる状態を作る)。
    fireEvent.click(screen.getByRole("radio", { name: "パック別の配分" }));
    fireEvent.click(screen.getByText("このパック専用に設定する"));

    // カードごとの調整タブへ移動し、intra weightを変更する
    fireEvent.click(screen.getByRole("button", { name: "カードごとの調整" }));
    const intraSlider = document.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(intraSlider, { target: { value: "2" } });

    fireEvent.click(screen.getByRole("button", { name: "一括保存" }));

    // 確認ダイアログが出て、キャンセル(false)を返したので保存処理も
    // モーダルを閉じる処理も走らない。
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
