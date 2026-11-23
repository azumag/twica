import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import TradeWantedRestrictionSettings from "@/components/TradeWantedRestrictionSettings";
import TradeSettings from "@/components/TradeSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

const ja = jaMessages.tradeWantedRestriction;

const CARDS = [
  { id: "card-a", name: "Alpha", rarity: "common", isActive: true },
  { id: "card-b", name: "Bravo", rarity: "rare", isActive: true },
  { id: "card-c", name: "Charlie", rarity: "rare", isActive: true },
  { id: "card-d", name: "Delta", rarity: "epic", isActive: true },
  { id: "card-old", name: "Retired", rarity: "common", isActive: false },
];

function renderEditor({
  allowed = null,
  maintenance = "off",
}: { allowed?: string[] | null; maintenance?: "off" | "on" } = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider
        value={{ mode: maintenance } as unknown as MaintenanceStatusResponse}
      >
        <TradeWantedRestrictionSettings
          cards={CARDS}
          initialAllowedWantedCardIds={allowed}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>,
  );
}

const optionNames = (select: HTMLElement) =>
  within(select).getAllByRole("option").map((option) => option.textContent ?? "");

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("TradeWantedRestrictionSettings", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the empty state and an add button when no list is set", () => {
    renderEditor();
    expect(screen.getByText(ja.empty)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ja.add })).toBeEnabled();
    // 配信者ごとに1つのリストなので、出品カードを選ぶドロップダウンは無い。
    expect(screen.queryByLabelText(ja.allowedAddLabel)).toBeNull();
  });

  it("adds cards one by one and saves the whole list with a PUT", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: ja.add }));

    // 自分の有効なカードはすべて候補になる(出品カードという概念は無い)。無効カードは出ない。
    const add = screen.getByLabelText(ja.allowedAddLabel);
    expect(optionNames(add).map((text) => text.split("（")[0])).toEqual([
      ja.allowedPlaceholder, "Alpha", "Bravo", "Charlie", "Delta",
    ]);
    expect(optionNames(add).join("")).not.toContain("Retired");
    expect(screen.getByRole("button", { name: ja.save })).toBeDisabled();

    fireEvent.change(add, { target: { value: "card-c" } });
    fireEvent.change(screen.getByLabelText(ja.allowedAddLabel), { target: { value: "card-d" } });
    // Already-added cards leave the dropdown.
    expect(optionNames(screen.getByLabelText(ja.allowedAddLabel)).join("")).not.toContain("Charlie");

    fireEvent.click(screen.getByRole("button", { name: ja.save }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/streamer/trade-wanted-restrictions");
    expect(init.method).toBe("PUT");
    // The streamer is resolved from the session; the body carries only the list.
    expect(JSON.parse(init.body)).toEqual({ allowedWantedCardIds: ["card-c", "card-d"] });

    // The saved list is shown and the form closes.
    const list = await screen.findByRole("list", { name: ja.allowedLabel });
    expect(within(list).getByText(/Charlie/)).toBeInTheDocument();
    expect(within(list).getByText(/Delta/)).toBeInTheDocument();
    expect(screen.getByText(ja.messages.saved)).toBeInTheDocument();
    expect(screen.queryByLabelText(ja.allowedAddLabel)).toBeNull();
  });

  it("stops offering more cards at the list limit and explains it (the API enforces the same limit)", async () => {
    const { TRADE_WANTED_RESTRICTION_MAX_ITEMS: MAX } = await import("@/lib/trade-wanted-restriction-limits");
    const many = Array.from({ length: MAX + 1 }, (_, index) => ({
      id: `w-${index}`, name: `W${index}`, rarity: "common", isActive: true,
    }));
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <MaintenanceStatusContext.Provider value={{ mode: "off" } as unknown as MaintenanceStatusResponse}>
          <TradeWantedRestrictionSettings cards={many} initialAllowedWantedCardIds={null} />
        </MaintenanceStatusContext.Provider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: ja.add }));
    for (let index = 0; index < MAX - 1; index += 1) {
      fireEvent.change(screen.getByLabelText(ja.allowedAddLabel), { target: { value: `w-${index}` } });
    }
    // One below the limit: still addable, no notice.
    expect(screen.getByLabelText(ja.allowedAddLabel)).toBeEnabled();
    expect(screen.queryByText(jaMessages.tradeWantedRestriction.allowedLimitReached.replace("{max}", String(MAX)))).toBeNull();
    fireEvent.change(screen.getByLabelText(ja.allowedAddLabel), { target: { value: `w-${MAX - 1}` } });
    // At the limit: the picker is disabled (the 101st candidate is not selectable) and the limit is shown.
    expect(screen.getByLabelText(ja.allowedAddLabel)).toBeDisabled();
    expect(
      screen.getByText(jaMessages.tradeWantedRestriction.allowedLimitReached.replace("{max}", String(MAX))),
    ).toBeInTheDocument();
    // Saving the full set is still allowed.
    expect(screen.getByRole("button", { name: ja.save })).toBeEnabled();
  });

  it("removing a card before saving changes the PUT body", async () => {
    renderEditor({ allowed: ["card-b", "card-c"] });
    fireEvent.click(screen.getByRole("button", { name: ja.edit }));
    fireEvent.click(screen.getByRole("button", { name: /Bravo.*交換対象から外す/ }));
    fireEvent.click(screen.getByRole("button", { name: ja.save }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      allowedWantedCardIds: ["card-c"],
    });
  });

  it("disables Save until the list changes", () => {
    renderEditor({ allowed: ["card-b"] });
    fireEvent.click(screen.getByRole("button", { name: ja.edit }));
    expect(screen.getByRole("button", { name: ja.save })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(ja.allowedAddLabel), { target: { value: "card-c" } });
    expect(screen.getByRole("button", { name: ja.save })).toBeEnabled();
  });

  it("removes the whole list by saving an empty set, and drops it from the UI only on success", async () => {
    renderEditor({ allowed: ["card-b"] });
    fireEvent.click(screen.getByRole("button", { name: ja.remove }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ allowedWantedCardIds: [] });
    await waitFor(() => expect(screen.getByText(ja.empty)).toBeInTheDocument());
    expect(screen.getByText(ja.messages.removed)).toBeInTheDocument();
  });

  it("keeps the saved state and shows the error when saving fails (no optimistic update)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "x" }));
    renderEditor({ allowed: ["card-b"] });
    fireEvent.click(screen.getByRole("button", { name: ja.remove }));
    expect(await screen.findByText(ja.errors.saveFailed)).toBeInTheDocument();
    // The list is still shown, not replaced by the empty state.
    expect(screen.queryByText(ja.empty)).toBeNull();
    expect(screen.getByRole("list", { name: ja.allowedLabel })).toBeInTheDocument();
  });

  it("explains a 503 (migration not applied yet)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { unavailable: true }));
    renderEditor({ allowed: ["card-b"] });
    fireEvent.click(screen.getByRole("button", { name: ja.remove }));
    expect(await screen.findByText(ja.errors.unavailable)).toBeInTheDocument();
  });

  it("warns about an empty list (nobody can request anything) and badges inactive allowed cards", () => {
    renderEditor({ allowed: [] });
    expect(screen.getByText(ja.emptyRuleWarning)).toBeInTheDocument();

    renderEditor({ allowed: ["card-old"] });
    expect(screen.getByText(ja.inactiveBadge)).toBeInTheDocument();
  });

  it("disables every control during maintenance", () => {
    renderEditor({ allowed: ["card-b"], maintenance: "on" });
    expect(screen.getByRole("button", { name: ja.edit })).toBeDisabled();
    expect(screen.getByRole("button", { name: ja.remove })).toBeDisabled();
  });

  it("is rendered by TradeSettings only when the initial data is available", () => {
    const tree = (restrictionSettings: React.ComponentProps<typeof TradeSettings>["restrictionSettings"]) => (
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <MaintenanceStatusContext.Provider value={{ mode: "off" } as unknown as MaintenanceStatusResponse}>
          <TradeSettings
            streamerId="s-1"
            currentTradeEnabled
            currentCrossChannelTradeEnabled={false}
            restrictionSettings={restrictionSettings}
          />
        </MaintenanceStatusContext.Provider>
      </NextIntlClientProvider>
    );
    const view = render(tree(null));
    expect(screen.queryByTestId("trade-wanted-restriction-settings")).toBeNull();
    view.rerender(tree({ cards: CARDS, allowedWantedCardIds: null }));
    expect(screen.getByTestId("trade-wanted-restriction-settings")).toBeInTheDocument();
  });
});
