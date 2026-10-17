import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { baseCard, renderCardManager } from "../../utils/card-manager-test-helpers";

vi.mock("@/lib/logger");

// Issue #1783 フェーズ2: ダッシュボードのカード一覧（CardManager）の
// 「リスト表示」への配線回帰。
//
// レビューで見つかった配線漏れは「CardList（既定のリスト表示）へ
// rarityStyles を渡していない」ものだった。CardList 単体のテストだけでは
// CardManager からの転送漏れを検知できないため、CardManager を実際に
// レンダリングしてバッジのクラスと CSS 変数を固定する。

const CUSTOM_RARITY = "mythic";
const CUSTOM_COLOR = "#ff0000";
const CUSTOM_STYLES = { [CUSTOM_RARITY]: { color: CUSTOM_COLOR } };

const customCard = baseCard({
  id: "card-mythic",
  name: "神話カード",
  rarity: CUSTOM_RARITY,
});

/** バッジ（レアリティ名を表示する span）を取得する。 */
const rarityBadge = () => screen.getByText(CUSTOM_RARITY);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

describe("CardManager リスト表示のレアリティ配色（Issue #1783）", () => {
  it("initialRarityStyles をリスト表示のバッジへ反映する", () => {
    renderCardManager([customCard], {
      initialRarityStyles: CUSTOM_STYLES,
      viewMode: "list",
    });

    const badge = rarityBadge();
    expect(badge.className).toContain("bg-[color:var(--rarity-color)]");
    expect(badge.getAttribute("style")).toContain(`--rarity-color: ${CUSTOM_COLOR}`);
  });

  it("initialRarityStyles 未指定なら従来のプリセット色のままにする", () => {
    renderCardManager([customCard], { viewMode: "list" });

    const badge = rarityBadge();
    expect(badge.className).toContain("bg-gray-500");
    expect(badge.getAttribute("style")).toBeNull();
  });
});
