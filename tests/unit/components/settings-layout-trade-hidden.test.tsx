import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import SettingsLayout from "@/components/SettingsLayout";
import jaMessages from "../../../messages/ja.json";

// SettingsLayout は各パネルを next/dynamic で遅延ロードする。このテストの関心は
// 「どのセクションが設定画面に出るか」だけなので、遅延パネルは空スタブへ置き換え、
// パネル固有の fetch や副作用をテストへ持ち込まない。
vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

// SettingsLayout は VoteCampaignButton を常に描画し、同コンポーネントが
// useRouter を呼ぶ。App Router をマウントしない単体テストでは実装をそのまま
// 使えないため、他コンポーネントテストと同じ形で最小スタブに差し替える。
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const section = jaMessages.settingsPage.advanced.section;

function renderLayout() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <SettingsLayout
        streamerId="streamer-1"
        plan="basic"
        baseUrl="https://example.com"
        cards={[]}
        showVoteCampaign={false}
        botAccount={null}
        channelPoint={{ rewardId: null, rewardName: null, collectionName: null }}
        gachaSound={{ soundUrl: null, soundEnabled: false }}
        chatAnnouncement={{
          enabled: false,
          needsAttention: false,
          template: null,
          multiTemplate: null,
          multiShowCards: true,
        }}
        liveDirectory={{ publishLiveStatus: false, publishStats: false }}
        // preview 側ではトレード設定・公開設定は /dashboard/account へ移動済みのため、
        // SettingsLayout は visibility / trade の props を持たない（main/preview 同期時に
        // preview の props 形へ合わせた）。account page 側の非表示は
        // tests/unit/account-page-collection-settings.test.tsx が固定する。
        initialModeHint="advanced"
      />
    </NextIntlClientProvider>,
  );
}

describe("SettingsLayout: カードトレード設定セクションの非表示 (#715)", () => {
  it("詳細モードにカードトレードのON/OFFトグルを表示しない", () => {
    renderLayout();

    // preview の messages には settingsPage.advanced.section.trade が無い（セクション
    // 自体が account page へ移動済み）ため、トレード設定フォームの実チェックボックスが
    // 詳細モードのどこにも現れないことで確認する。
    expect(
      screen.queryByRole("checkbox", {
        name: jaMessages.tradeSettings.form.tradeEnabled,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", {
        name: jaMessages.tradeSettings.form.crossChannelEnabled,
      }),
    ).not.toBeInTheDocument();
  });

  it("非表示フラグの対象外セクションは従来どおり表示する", () => {
    renderLayout();

    // サイドバーの先頭から末尾までの代表として、直前・直後のセクションが
    // 残っていることを確認する(フィルタがセクション一覧全体を壊していない)。
    expect(screen.getByText(section.liveDirectory)).toBeInTheDocument();
    expect(screen.getByText(section.share)).toBeInTheDocument();
    expect(screen.getByText(section.overlay)).toBeInTheDocument();
  });
});
