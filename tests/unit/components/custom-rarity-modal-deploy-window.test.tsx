import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import CustomRarityModal from "@/components/CustomRarityModal";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { RarityStyle } from "@/lib/rarity-styles";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// Issue #1783: デプロイ窓（rarity_styles 列が未作成）の部分保存。
// サーバーは名前だけを保存して 200 + rarityStylesSkippedDeployWindow を返すため、
// UI が「保存できた」として閉じてしまうと未保存の色が保存済みに見えてしまう。
// ここでは (1) 部分保存で成功扱いにしない、(2) 下書きが残る、(3) 再保存で反映される、
// (4) 閉じて開き直すと保存済みの値に戻る、を固定する。
// 挙動は #1822 の同名実装（partialSaveSync）に合わせている。

const PARTIAL_SAVE_MESSAGE =
  "レアリティ名は保存しましたが、表示スタイルはまだ利用できないため保存できませんでした。しばらくしてから再度お試しください。";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function Harness({ onClose }: { onClose: () => void }) {
  const [isOpen, setIsOpen] = useState(true);
  const [customRarities, setCustomRarities] = useState<string[]>(["特別"]);
  // 保存済みの色（親が持つ「DBに入っている値」）。
  const [rarityStyles, setRarityStyles] = useState<Record<string, RarityStyle>>({
    特別: { color: "#00ff00" },
  });

  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>
        reopen
      </button>
      <div data-testid="persisted-styles">{JSON.stringify(rarityStyles)}</div>
      <CustomRarityModal
        isOpen={isOpen}
        onClose={() => {
          setIsOpen(false);
          onClose();
        }}
        streamerId="streamer-1"
        customRarities={customRarities}
        rarityStyles={rarityStyles}
        onSaved={setCustomRarities}
        onSavedStyles={setRarityStyles}
      />
    </>
  );
}

function renderHarness() {
  const onClose = vi.fn();
  render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={{ mode: "off" }}>
        <Harness onClose={onClose} />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
  return { onClose };
}

/** 色入力を変更して「色だけ」の変更を作る。 */
function changeColor(value: string) {
  fireEvent.change(screen.getByLabelText("特別 の文字色"), { target: { value } });
}

describe("CustomRarityModal deploy-window partial save (Issue #1783)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("200 + rarityStylesSkippedDeployWindow では保存成功として閉じず、警告と下書きを残す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ rarityStylesSkippedDeployWindow: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { onClose } = renderHarness();

    changeColor("#ff0000");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByText(PARTIAL_SAVE_MESSAGE)).toBeInTheDocument();
    });
    // 未保存の色を保存済みとして親へ渡さない（親の保存済み値は従来のまま）。
    expect(screen.getByTestId("persisted-styles")).toHaveTextContent("#00ff00");
    expect(screen.getByTestId("persisted-styles")).not.toHaveTextContent("#ff0000");
    // 成功として閉じない。下書きは残る（再試行できる）。
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("特別 の文字色")).toHaveValue("#ff0000");
  });

  it("部分保存のあとの再保存（通常200）で色が反映され、閉じる", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ rarityStylesSkippedDeployWindow: true }))
      .mockResolvedValueOnce(jsonResponse({ rarityStyles: { 特別: { color: "#ff0000" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const { onClose } = renderHarness();

    changeColor("#ff0000");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(screen.getByText(PARTIAL_SAVE_MESSAGE)).toBeInTheDocument();
    });

    // 列が展開されたあとの再保存。下書きがそのまま送られて反映される。
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(screen.getByTestId("persisted-styles")).toHaveTextContent("#ff0000");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondBody.rarityStyles).toEqual({ 特別: { color: "#ff0000" } });
  });

  it("部分保存のあと閉じて開き直すと、未保存の下書きは残らず保存済みの値へ戻る", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ rarityStylesSkippedDeployWindow: true }));
    vi.stubGlobal("fetch", fetchMock);
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderHarness();

    changeColor("#ff0000");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(screen.getByText(PARTIAL_SAVE_MESSAGE)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Close"));
    expect(confirmMock).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "reopen" }));
    await waitFor(() => {
      expect(screen.getByLabelText("特別 の文字色")).toHaveValue("#00ff00");
    });
  });
});
