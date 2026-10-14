import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import StreamerCollection from "@/components/StreamerCollection";
import type { Streamer } from "@/types/database";

// #715: 一般公開準備中は CARD_TRADE_UI_VISIBLE=false でコレクションの「トレード」導線を
// 隠す。ここでは実描画で「trade_enabled=true でもリンクが出ない」ことを固定する
// (定数を true に戻すとリンクが復帰することは mutation で確認済み)。
// StreamerCollection は async Server Component のため、await して得た JSX を render する。
vi.mock("next-intl/server", () => ({
  // キーをそのまま返す t 関数（構造検証に翻訳内容は不要）
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/components/Stats", () => ({
  default: () => <div data-testid="stats" />,
}));
vi.mock("@/components/CollectionProgress", () => ({
  default: () => <div data-testid="collection-progress" />,
}));
vi.mock("@/components/SortedCardGrid", () => ({
  default: () => <div data-testid="sorted-card-grid" />,
}));
vi.mock("@/components/CollectionPackFilter", () => ({
  default: () => <div data-testid="pack-filter" />,
}));

// 導線を出す条件(trade_enabled=true)を満たす配信者を渡す。
const streamer = {
  id: "streamer-1",
  twitch_display_name: "TestStreamer",
  twitch_profile_image_url: null,
  trade_enabled: true,
} as unknown as Streamer;

describe("StreamerCollection: トレード導線の非表示 (#715)", () => {
  it("trade_enabled=true でも /trade へのリンクを表示しない", async () => {
    const { container } = render(
      await StreamerCollection({
        streamer,
        cards: [],
        stats: { total: 0, unique: 0, legendary: 0, epic: 0, rare: 0, common: 0 },
        progress: { owned: 0, total: 0 },
        visibleCardTypes: 0,
      }),
    );

    expect(container.querySelector('a[href^="/trade/"]')).toBeNull();

    // 入口を消しただけでコレクション画面自体は壊れていないことを同時に確認する
    // (全描画が失敗して「リンクが無い」ように見える偽陽性を防ぐ)。
    expect(screen.getByTestId("stats")).toBeInTheDocument();
    expect(screen.getByTestId("collection-progress")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});
