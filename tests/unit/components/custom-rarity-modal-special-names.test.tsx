import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import CustomRarityModal from "@/components/CustomRarityModal";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { RarityStyle } from "@/lib/rarity-styles";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// Issue #1783 互換: 画面側（validateCustomRaritiesInput）は "constructor" /
// "prototype" をカスタムレアリティ名として許可する。保存 API 側の validator が
// これらを拒否すると「名前は登録できるのに色を設定すると編集全体が 400 になる」。
// ここでは、その2名に色を設定して保存する一連の操作が通ることを UI 経由で固定する。
//
// 併せて、オブジェクトマップとして安全に表現できない "__proto__" だけは
// 引き続き拒否されることを API 側のテスト（streamer-settings-api）で担保している。

const SPECIAL_NAMES = ["constructor", "prototype"] as const;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function Harness() {
  const [isOpen, setIsOpen] = useState(true);
  const [rarityStyles, setRarityStyles] = useState<Record<string, RarityStyle>>({});

  return (
    <>
      <div data-testid="persisted-styles">{JSON.stringify(rarityStyles)}</div>
      <CustomRarityModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        streamerId="streamer-1"
        customRarities={[...SPECIAL_NAMES]}
        rarityStyles={rarityStyles}
        onSaved={() => {}}
        onSavedStyles={setRarityStyles}
      />
    </>
  );
}

describe("CustomRarityModal: constructor / prototype 名のレアリティ", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("その2名に色を設定して保存でき、payload にそのまま載る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        rarityStyles: { constructor: { color: "#ff0000" }, prototype: { color: "#00ff00" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <MaintenanceStatusContext.Provider value={{ mode: "off" }}>
          <Harness />
        </MaintenanceStatusContext.Provider>
      </NextIntlClientProvider>,
    );

    // 継承プロパティ（Object.prototype.constructor）に引きずられずに色を入力できる。
    fireEvent.change(screen.getByLabelText("constructor の文字色"), {
      target: { value: "#ff0000" },
    });
    fireEvent.change(screen.getByLabelText("prototype の文字色"), {
      target: { value: "#00ff00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(Object.prototype.hasOwnProperty.call(body.rarityStyles, "constructor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body.rarityStyles, "prototype")).toBe(true);
    expect(body.rarityStyles.constructor).toEqual({ color: "#ff0000" });
    expect(body.rarityStyles.prototype).toEqual({ color: "#00ff00" });
    // グローバルなプロトタイプ汚染が起きていないこと。
    expect(({} as Record<string, unknown>).color).toBeUndefined();

    // 親の保存済み state にも own プロパティとして反映される。
    await waitFor(() => {
      expect(screen.getByTestId("persisted-styles")).toHaveTextContent('"constructor":{"color":"#ff0000"}');
    });
  });
});
