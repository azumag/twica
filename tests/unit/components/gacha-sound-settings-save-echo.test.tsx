import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import GachaSoundSettings from "@/components/GachaSoundSettings";
import jaMessages from "../../../messages/ja.json";
import type { GachaSoundRule } from "@/lib/gacha-sound-rules";
import type { Json } from "@/types/database";

vi.mock("@/lib/logger");

// PR #451 レビュー指摘 F5 のリグレッションガード:
// GachaSoundSettings.saveRules は保存成功(200)時に送信した配列をそのまま
// 楽観反映していたが、/api/streamer/settings はサーバー側の正規化
// (不正URL除外・デッドルール除外・件数上限)やデプロイ窓での書き込み
// スキップにより、実際に永続化された値が送信値と食い違うことがある。
// この場合でも 200 が返るため、クライアントは「保存できた」体のまま
// 実態とズレた state を表示し続けてしまう(サイレント欠損)。
// route.ts が返す gachaSoundRules(実際に永続化された値)+
// gachaSoundRulesSkippedDeployWindow フラグを使って state を再同期する
// ことを検証する。

type FetchMock = ReturnType<typeof vi.fn>;

function ruleFixture(overrides: Partial<GachaSoundRule> = {}): GachaSoundRule {
  return {
    id: "rule-1",
    url: "https://example.com/before.mp3",
    enabled: true,
    label: "Before",
    targetType: "all",
    rarity: null,
    rewardId: null,
    rewardName: null,
    ...overrides,
  };
}

function mockSettingsFetch(responseBody: unknown, status = 200): FetchMock {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/streamer/settings")) {
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function renderComponent(props: Partial<React.ComponentProps<typeof GachaSoundSettings>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <GachaSoundSettings
        streamerId="streamer-1"
        plan="support"
        currentSoundUrl={null}
        currentSoundEnabled={false}
        currentSoundRules={[ruleFixture()] as unknown as Json}
        currentRewardId={null}
        currentRewardName={null}
        {...props}
      />
    </NextIntlClientProvider>
  );
}

describe("GachaSoundSettings save echo + deploy-window resync (Issue #451 followup F5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resyncs the rule list from the server-echoed gachaSoundRules on success, not the locally-submitted array", async () => {
    // サーバーは「label が正規化された」別の値を返す想定
    // (実際の正規化内容が何であれ、クライアントはサーバーのエコーバックを信じるべき)。
    const fetchMock = mockSettingsFetch({
      success: true,
      gachaSoundRules: [ruleFixture({ label: "ServerNormalized" })],
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent();

    const enableCheckbox = await screen.findByLabelText("効果音を有効にする");
    fireEvent.click(enableCheckbox);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/streamer/settings",
        expect.objectContaining({ method: "POST" })
      );
    });

    // 送信した nextRules の label ("Before")ではなく、サーバーが
    // エコーバックした label ("ServerNormalized")で再描画されているはず。
    await waitFor(() => {
      expect(screen.getByDisplayValue("ServerNormalized")).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue("Before")).not.toBeInTheDocument();
  });

  it("falls back to the locally-submitted rules when the response omits gachaSoundRules (defensive)", async () => {
    const fetchMock = mockSettingsFetch({ success: true });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent();

    const enableCheckbox = await screen.findByLabelText("効果音を有効にする");
    fireEvent.click(enableCheckbox);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    // gachaSoundRules が応答に無ければ、送信した値をそのまま維持する。
    await waitFor(() => {
      expect(screen.getByDisplayValue("Before")).toBeInTheDocument();
    });
  });

  it("surfaces a deploy-window message and resyncs to the actually-persisted (empty) value when the write was skipped", async () => {
    const fetchMock = mockSettingsFetch({
      success: true,
      gachaSoundRules: [],
      gachaSoundRulesSkippedDeployWindow: true,
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent();

    const enableCheckbox = await screen.findByLabelText("効果音を有効にする");
    fireEvent.click(enableCheckbox);

    await waitFor(() => {
      expect(
        screen.getByText(
          "効果音ルール機能が準備中のため、変更は保存できませんでした。しばらくしてから再度お試しください。"
        )
      ).toBeInTheDocument();
    });

    // 実際には何も永続化されていない(サーバーが返した空配列)ため、
    // UI 上も「まだ登録されていない」状態に戻る(=保存できた体のまま
    // 食い違って残るサイレント欠損を防ぐ)。
    expect(screen.getByText("効果音はまだ登録されていません。")).toBeInTheDocument();
  });
});
