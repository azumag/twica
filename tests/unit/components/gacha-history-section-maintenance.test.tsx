import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import GachaHistorySection from "@/components/GachaHistorySection";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";
import type { GachaHistory, Card } from "@/types/database";

vi.mock("@/lib/logger");

// #694 Stage 6c: GachaHistorySection の書き込み経路
// (DELETE /api/gacha-history/[id]) に対するmaintenance統合テスト。

type GachaHistoryWithCard = GachaHistory & { cards: Card };

function historyEntry(overrides: Partial<GachaHistoryWithCard> = {}): GachaHistoryWithCard {
  return {
    id: "history-1",
    streamer_id: "streamer-1",
    card_id: "card-1",
    user_twitch_id: "user-1",
    user_twitch_username: "viewer1",
    redeemed_at: "2026-07-01T00:00:00Z",
    cards: {
      id: "card-1",
      streamer_id: "streamer-1",
      name: "カードA",
      description: "",
      image_url: null,
      rarity: "common",
      card_number: null,
      max_issuance_count: null,
      collection_name: null,
      drop_rate: 0.25,
      intra_rarity_weight: 1,
      is_active: true,
      hp: 10,
      atk: 5,
      def: 5,
      spd: 5,
      skill_type: "attack",
      skill_name: "たいあたり",
      skill_power: 10,
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-01T00:00:00Z",
    } as Card,
    ...overrides,
  } as GachaHistoryWithCard;
}

function renderSection(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <GachaHistorySection recentGacha={[historyEntry()]} isStreamer />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

describe("GachaHistorySection maintenance integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode=off のときは削除ボタンが操作可能（既存挙動を壊さない）", () => {
    renderSection({ mode: "off" });
    expect(screen.getByRole("button", { name: "削除" })).not.toBeDisabled();
  });

  it("mode!=off のときは削除ボタンがdisableされ、tooltipで理由が表示される（事前disable）", () => {
    renderSection({ mode: "read-only" });
    const button = screen.getByRole("button", { name: "削除" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "メンテナンス中は操作できません");
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

    renderSection({ mode: "off" });
    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalled();
      const [message] = alertMock.mock.calls[0];
      expect(String(message)).toContain(
        "ただいまメンテナンス中です。しばらくしてから再度お試しください。"
      );
      expect(String(message)).not.toContain("[object Object]");
    });

    confirmMock.mockRestore();
    alertMock.mockRestore();
  });
});
