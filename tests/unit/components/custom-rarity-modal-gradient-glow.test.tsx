import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import CustomRarityModal from "@/components/CustomRarityModal";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { RarityStyle } from "@/lib/rarity-styles";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

// Issue #2029: グラデーション(2色)とグロー(色+不透明度)を画面から編集できる
// ことを固定する。保存される値は API 検証(rarity-styles.ts)と同じ HEX 形式
// ("#rrggbb,#rrggbb" / "#rrggbb" / "#rrggbbaa") でなければならない。

const RARITY = "ultra";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function Harness({ initialStyles = {} }: { initialStyles?: Record<string, RarityStyle> }) {
  const [isOpen, setIsOpen] = useState(true);
  const [rarityStyles, setRarityStyles] = useState(initialStyles);

  return (
    <>
      <div data-testid="persisted-styles">{JSON.stringify(rarityStyles)}</div>
      <CustomRarityModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        streamerId="streamer-1"
        customRarities={[RARITY]}
        rarityStyles={rarityStyles}
        onSaved={() => {}}
        onSavedStyles={setRarityStyles}
      />
    </>
  );
}

function renderModal(initialStyles?: Record<string, RarityStyle>) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={{ mode: "off" }}>
        <Harness initialStyles={initialStyles} />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>,
  );
}

async function saveAndReadBody(fetchMock: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe("CustomRarityModal: グラデーション・グロー編集 (Issue #2029)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("グラデーション2色とグロー色を設定すると HEX 形式で保存される", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderModal();

    fireEvent.change(screen.getByLabelText(`${RARITY} のグラデーション開始色`), {
      target: { value: "#ff0000" },
    });
    fireEvent.change(screen.getByLabelText(`${RARITY} のグラデーション終了色`), {
      target: { value: "#0000ff" },
    });
    fireEvent.change(screen.getByLabelText(`${RARITY} のグロー色`), {
      target: { value: "#00ff00" },
    });

    const body = await saveAndReadBody(fetchMock);
    expect(body.rarityStyles[RARITY]).toEqual({
      gradient: "#ff0000,#0000ff",
      glow: "#00ff00",
    });
  });

  it("グロー不透明度を下げると #RRGGBBAA のアルファ付きで保存される", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderModal();

    fireEvent.change(screen.getByLabelText(`${RARITY} のグロー色`), {
      target: { value: "#00ff00" },
    });
    fireEvent.change(screen.getByLabelText(`${RARITY} のグロー不透明度`), {
      target: { value: "50" },
    });

    const body = await saveAndReadBody(fetchMock);
    expect(body.rarityStyles[RARITY]).toEqual({ glow: "#00ff0080" });
  });

  it("プロパティごとの「既定に戻す」でそのキーだけが外れて保存される", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    renderModal({
      [RARITY]: { color: "#123456", gradient: "#ff0000,#0000ff", glow: "#00ff0080" },
    });

    fireEvent.click(screen.getByLabelText(`${RARITY} のグラデーションを既定に戻す`));
    fireEvent.click(screen.getByLabelText(`${RARITY} のグローを既定に戻す`));

    const body = await saveAndReadBody(fetchMock);
    expect(body.rarityStyles[RARITY]).toEqual({ color: "#123456" });
  });
});
