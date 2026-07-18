import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import CustomRarityModal from "@/components/CustomRarityModal";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// #694 Stage 6c: CustomRarityModal の書き込み経路
// (POST /api/streamer/settings のカスタムレアリティ保存) に対する
// maintenance統合テスト。

function renderModal(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <CustomRarityModal
          isOpen
          onClose={vi.fn()}
          streamerId="streamer-1"
          customRarities={["特別"]}
          onSaved={vi.fn()}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

describe("CustomRarityModal maintenance integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode=off で変更ありのときは保存ボタンが操作可能（既存挙動を壊さない）", () => {
    renderModal({ mode: "off" });
    fireEvent.click(screen.getByLabelText("Remove 特別"));

    const saveButton = screen.getByRole("button", { name: "保存" });
    expect(saveButton).not.toBeDisabled();
    expect(screen.queryByText("メンテナンス中は操作できません")).not.toBeInTheDocument();
  });

  it("mode!=off のときは変更ありでも保存ボタンがdisableされ、案内文言が表示される（事前disable）", () => {
    renderModal({ mode: "read-only" });
    fireEvent.click(screen.getByLabelText("Remove 特別"));

    const saveButton = screen.getByRole("button", { name: "保存" });
    expect(saveButton).toBeDisabled();
    expect(screen.getByText("メンテナンス中は操作できません")).toBeInTheDocument();
  });

  it("事前disableをすり抜けて保存が503(maintenance)で拒否された場合、サーバーの案内文言を表示する", async () => {
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

    renderModal({ mode: "off" });
    fireEvent.click(screen.getByLabelText("Remove 特別"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(
        screen.getByText("ただいまメンテナンス中です。しばらくしてから再度お試しください。")
      ).toBeInTheDocument();
    });
  });
});
