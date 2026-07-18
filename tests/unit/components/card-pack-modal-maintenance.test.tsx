import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import CardPackModal from "@/components/CardPackModal";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// #694 Stage 6c: CardPackModal の書き込み経路
// (POST /api/streamer/settings の一括保存、PATCH /api/cards/collections の
// 通常パックリネーム、POST /api/streamer/settings のデフォルトパックリネーム)
// に対するmaintenance統合テスト。

function renderModal(status: MaintenanceStatusResponse, props: Partial<React.ComponentProps<typeof CardPackModal>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <CardPackModal
          isOpen
          onClose={vi.fn()}
          streamerId="streamer-1"
          cardPackNames={["weapons"]}
          defaultPackName={null}
          isPremium
          onSaved={vi.fn()}
          onDefaultPackNameSaved={vi.fn()}
          {...props}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

function maintenanceErrorResponse(message = "ただいまメンテナンス中です。しばらくしてから再度お試しください。") {
  return new Response(
    JSON.stringify({ error: { code: "maintenance_read_only", message, retryable: true } }),
    { status: 503 }
  );
}

describe("CardPackModal maintenance integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode=off で変更ありのときは保存ボタンが操作可能（既存挙動を壊さない）", () => {
    renderModal({ mode: "off" });
    // 削除で hasChanges=true にする（追加はisPremium依存だが削除は常に可能）
    fireEvent.click(screen.getByLabelText("Remove weapons"));

    const saveButton = screen.getByRole("button", { name: "保存" });
    expect(saveButton).not.toBeDisabled();
    expect(screen.queryByText("メンテナンス中は操作できません")).not.toBeInTheDocument();
  });

  it("mode!=off のときは変更ありでも保存ボタンがdisableされ、案内文言が表示される（事前disable）", () => {
    renderModal({ mode: "read-only" });
    fireEvent.click(screen.getByLabelText("Remove weapons"));

    const saveButton = screen.getByRole("button", { name: "保存" });
    expect(saveButton).toBeDisabled();
    expect(screen.getByText("メンテナンス中は操作できません")).toBeInTheDocument();
  });

  it("事前disableをすり抜けて一括保存が503(maintenance)で拒否された場合、サーバーの案内文言を表示する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(maintenanceErrorResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderModal({ mode: "off" });
    fireEvent.click(screen.getByLabelText("Remove weapons"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(
        screen.getByText("ただいまメンテナンス中です。しばらくしてから再度お試しください。")
      ).toBeInTheDocument();
    });
  });

  it("リネームのSaveボタンはmode!=offでdisableされる", () => {
    renderModal({ mode: "read-only" });
    fireEvent.click(screen.getByLabelText("Rename weapons"));

    const saveButtons = screen.getAllByRole("button", { name: "保存" });
    // 1つはインライン(リネーム行)、もう1つはフッターの一括保存ボタン。
    // どちらもmaintenance中はdisableされる。
    expect(saveButtons.length).toBeGreaterThan(0);
    saveButtons.forEach((button) => expect(button).toBeDisabled());
  });

  it("事前disableをすり抜けてリネーム入力のEnterキーから送信されても、送信前にガードしてサーバーへfetchしない", async () => {
    const fetchMock = vi.fn().mockResolvedValue(maintenanceErrorResponse());
    vi.stubGlobal("fetch", fetchMock);

    renderModal({ mode: "read-only" });
    fireEvent.click(screen.getByLabelText("Rename weapons"));

    const input = screen.getByDisplayValue("weapons");
    fireEvent.change(input, { target: { value: "weapons2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getAllByText("メンテナンス中は操作できません").length).toBeGreaterThan(0);
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/cards/collections",
      expect.anything()
    );
  });
});
