import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import GachaSoundSettings from "@/components/GachaSoundSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";
import type { GachaSoundRule } from "@/lib/gacha-sound-rules";
import type { Json } from "@/types/database";

vi.mock("@/lib/logger");

// #694 Stage 6c: GachaSoundSettings の書き込み経路
// (POST/DELETE /api/upload/sound、POST /api/streamer/settings) に対する
// maintenance統合テスト。

function ruleFixture(overrides: Partial<GachaSoundRule> = {}): GachaSoundRule {
  return {
    id: "rule-1",
    url: "https://example.com/sound.mp3",
    enabled: true,
    label: "効果音",
    targetType: "all",
    rarity: null,
    rewardId: null,
    rewardName: null,
    ...overrides,
  };
}

function renderSettings(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <GachaSoundSettings
          streamerId="streamer-1"
          plan="support"
          currentSoundUrl={null}
          currentSoundEnabled={false}
          currentSoundRules={[ruleFixture()] as unknown as Json}
          currentRewardId={null}
          currentRewardName={null}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

function getFileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

describe("GachaSoundSettings maintenance integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode=off のときはルール編集セクションがinertではない（既存挙動を壊さない）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderSettings({ mode: "off" });
    // isPremium時にマウント時発火する報酬一覧取得(GET /api/twitch/rewards)の
    // 完了を待ってからアサートする(act警告防止)。
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const section = container.querySelector("div.space-y-4") as HTMLElement;
    expect(section.hasAttribute("inert")).toBe(false);
    expect(getFileInput(container)).not.toBeDisabled();
    expect(screen.queryByText("メンテナンス中は操作できません")).not.toBeInTheDocument();
  });

  it("mode!=off のときはルール編集セクション全体がinertになり、案内文言が表示される（事前disable）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderSettings({ mode: "read-only" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const section = container.querySelector("div.space-y-4") as HTMLElement;
    expect(section.hasAttribute("inert")).toBe(true);
    expect(getFileInput(container)).toBeDisabled();
    expect(getFileInput(container)).toHaveAttribute("title", "メンテナンス中は操作できません");
    expect(screen.getByText("メンテナンス中は操作できません")).toBeInTheDocument();
  });

  it("事前disableをすり抜けて効果音削除が503(maintenance)で拒否された場合、サーバーの案内文言を表示する", async () => {
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
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

    // ポーリング間隔中に切り替わった想定: UI上はまだmode=offなので削除ボタンは押せる
    renderSettings({ mode: "off" });
    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    await waitFor(() => {
      expect(
        screen.getByText("ただいまメンテナンス中です。しばらくしてから再度お試しください。")
      ).toBeInTheDocument();
    });

    confirmMock.mockRestore();
  });
});
