import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import DropRateSettingsModal from "@/components/DropRateSettingsModal";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// #694 Stage 6c: DropRateSettingsModal.switchMode
// (POST /api/streamer/settings、自動/手動モード切替) に対するmaintenance
// 統合テスト。トリガーボタンは子コンポーネント(DropRateAutoModeContent)側に
// あるため、実際のモーダルツリーを通して検証する。

function renderModal(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <DropRateSettingsModal
          isOpen
          onClose={vi.fn()}
          cards={[]}
          streamerId="streamer-1"
          onCardsSave={vi.fn()}
          onRarityWeightsApply={vi.fn()}
          rarityWeights={{ common: 70, rare: 20, epic: 8, legendary: 2 }}
          customRarities={[]}
          cardPackNames={[]}
          defaultPackName={null}
          rarityWeightsScope="global"
          packRarityWeights={null}
          onPackWeightsApply={vi.fn()}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

describe("DropRateSettingsModal maintenance integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode!=off のときはモード切替ボタンがdisableされる（事前disable）", () => {
    renderModal({ mode: "read-only" });
    expect(screen.getByText("手動調整モードに切り替える")).toBeDisabled();
  });

  it("事前disableをすり抜けてモード切替が503(maintenance)で拒否された場合、サーバーの案内文言をalertで表示する", async () => {
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "maintenance_read_only",
            message: "ただいまメンテナンス中です。しばらくしてから再度お試しください。",
            retryable: true,
          },
        }),
        { status: 503 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    // ポーリング間隔中に切り替わった想定: UI上はまだmode=offなのでボタンは押せる
    renderModal({ mode: "off" });
    fireEvent.click(screen.getByText("手動調整モードに切り替える"));

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(
        "ただいまメンテナンス中です。しばらくしてから再度お試しください。"
      );
    });

    confirmMock.mockRestore();
    alertMock.mockRestore();
  });
});
