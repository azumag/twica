import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import DropRateAutoModeContent from "@/components/DropRateAutoModeContent";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";
import { baseCard } from "../../utils/card-manager-test-helpers";

vi.mock("@/lib/logger");

// #694 Stage 6c: DropRateAutoModeContent の書き込み経路
// (POST /api/streamer/settings のレアリティ別配分保存、
// POST /api/cards/batch-update のカードごと配分保存) に対する
// maintenance統合テスト。

type Props = React.ComponentProps<typeof DropRateAutoModeContent>;

function renderContent(status: MaintenanceStatusResponse, overrides: Partial<Props> = {}) {
  const defaultProps: Props = {
    cards: [baseCard({ id: "a", rarity: "common", is_active: true, intra_rarity_weight: 1 })],
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
      <MaintenanceStatusContext.Provider value={status}>
        <DropRateAutoModeContent {...defaultProps} {...overrides} />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

function maintenanceErrorResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: "maintenance_read_only",
        message: "ただいまメンテナンス中です。しばらくしてから再度お試しください。",
        retryable: true,
      },
    }),
    { status: 503 }
  );
}

// 合計100%制約(isRarityTotalValid)を保ったまま変更ありにするため、
// common(70→71)とrare(20→19)の2つを同時に動かす。
function makeValidRarityChange() {
  const inputs = document.querySelectorAll('input[type="number"]');
  fireEvent.change(inputs[0], { target: { value: "71" } });
  fireEvent.change(inputs[1], { target: { value: "19" } });
}

describe("DropRateAutoModeContent maintenance integration (rarity tab)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode=off で変更ありのときは保存ボタンが操作可能（既存挙動を壊さない）", () => {
    renderContent({ mode: "off" });
    makeValidRarityChange();

    const saveButton = screen.getByRole("button", { name: "保存して適用" });
    expect(saveButton).not.toBeDisabled();
    expect(screen.queryByText("メンテナンス中は操作できません")).not.toBeInTheDocument();
  });

  it("mode!=off のときは変更ありでも保存ボタンがdisableされ、案内文言が表示される（事前disable）", () => {
    renderContent({ mode: "read-only" });
    makeValidRarityChange();

    const saveButton = screen.getByRole("button", { name: "保存して適用" });
    expect(saveButton).toBeDisabled();
    expect(screen.getByText("メンテナンス中は操作できません")).toBeInTheDocument();
  });

  it("事前disableをすり抜けて保存が503(maintenance)で拒否された場合、サーバーの案内文言を表示する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(maintenanceErrorResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderContent({ mode: "off" });
    makeValidRarityChange();
    fireEvent.click(screen.getByRole("button", { name: "保存して適用" }));

    await waitFor(() => {
      expect(
        screen.getByText("ただいまメンテナンス中です。しばらくしてから再度お試しください。")
      ).toBeInTheDocument();
    });
  });

  it("手動モードへの切替ボタンもmode!=offでdisableされる", () => {
    renderContent({ mode: "read-only" });
    expect(screen.getByText("手動調整モードに切り替える")).toBeDisabled();
  });
});

describe("DropRateAutoModeContent maintenance integration (per-card tab)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode!=off のときはカードごとタブの保存ボタンもdisableされる", () => {
    renderContent({ mode: "read-only" });
    fireEvent.click(screen.getByText("カードごとの調整"));

    const slider = document.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "3" } });

    const saveButton = screen.getByRole("button", { name: "一括保存" });
    expect(saveButton).toBeDisabled();
  });

  it("事前disableをすり抜けてカードごと保存が503(maintenance)で拒否された場合、サーバーの案内文言をalertで表示する", async () => {
    const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(maintenanceErrorResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderContent({ mode: "off" });
    fireEvent.click(screen.getByText("カードごとの調整"));
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "一括保存" }));

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(
        "ただいまメンテナンス中です。しばらくしてから再度お試しください。"
      );
    });

    alertMock.mockRestore();
  });
});
