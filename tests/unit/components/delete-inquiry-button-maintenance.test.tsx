import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import DeleteInquiryButton from "@/components/DeleteInquiryButton";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// #694 Stage 6c: DeleteInquiryButton の書き込み経路
// (DELETE /api/support-inquiries/[id]) に対するmaintenance統合テスト。

function renderButton(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <DeleteInquiryButton inquiryId="inquiry-1" />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

describe("DeleteInquiryButton maintenance integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode=off のときは削除ボタンが操作可能（既存挙動を壊さない）", () => {
    renderButton({ mode: "off" });
    expect(screen.getByRole("button", { name: "削除" })).not.toBeDisabled();
  });

  it("mode!=off のときは削除ボタンがdisableされ、tooltipで理由が表示される（事前disable）", () => {
    renderButton({ mode: "read-only" });
    const button = screen.getByRole("button", { name: "削除" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "メンテナンス中は操作できません");
  });

  it("incident-read-only でも同様にdisableされる", () => {
    renderButton({ mode: "incident-read-only" });
    expect(screen.getByRole("button", { name: "削除" })).toBeDisabled();
  });

  it("事前disableをすり抜けて削除が503(maintenance)で拒否された場合、サーバーの案内文言をalertで表示する", async () => {
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
    renderButton({ mode: "off" });
    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(
        "ただいまメンテナンス中です。しばらくしてから再度お試しください。"
      );
    });

    confirmMock.mockRestore();
    alertMock.mockRestore();
  });
});
