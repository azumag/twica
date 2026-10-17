import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CollectionCard from "@/components/CollectionCard";
import CardList from "@/components/CardList";
import { getRarityStylePresentation, type RarityStyleVars } from "@/lib/rarity";
import type { RarityStyles } from "@/lib/rarity-styles";
import type { Card } from "@/types/database";

// Issue #1783 フェーズ2: 配線の回帰テスト。
//
// getRarityStylePresentation 単体のテストだけでは「描画コンポーネントへ
// styleVars を渡し忘れる」配線漏れを検知できない。実際にレビューで
// ダッシュボードのリスト表示（CardList）の配線漏れが見つかったため、
// バッジを描画する各コンポーネントで
//   - className に var() 参照クラスが入ること
//   - style 属性に CSS カスタムプロパティが入ること
// を DOM で固定する。

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const CUSTOM_RARITY = "mythic";
const CUSTOM_COLOR = "#ff0000";
const CUSTOM_STYLES: RarityStyles = { [CUSTOM_RARITY]: { color: CUSTOM_COLOR } };

const baseCard: Card = {
  id: "card-1",
  streamer_id: "streamer-1",
  name: "カードA",
  description: "説明",
  image_url: null,
  image_padding_color: null,
  rarity: CUSTOM_RARITY,
  card_number: null,
  max_issuance_count: null,
  collection_name: null,
  drop_rate: 25,
  intra_rarity_weight: 1,
  is_active: true,
  hp: 10,
  atk: 5,
  def: 5,
  spd: 5,
  skill_type: "attack",
  skill_name: "たいあたり",
  skill_power: 10,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

const expectedClass = getRarityStylePresentation(CUSTOM_RARITY, CUSTOM_STYLES).colorClass;

describe("レアリティ配色の配線（Issue #1783）", () => {
  it("CollectionCard のバッジに var() 参照クラスと CSS 変数を当てる", () => {
    render(
      <CollectionCard
        id={baseCard.id}
        streamerId="streamer-1"
        name={baseCard.name}
        imageUrl={null}
        rarityInfo={{
          label: CUSTOM_RARITY,
          color: expectedClass,
          styleVars: { "--rarity-color": CUSTOM_COLOR } as RarityStyleVars,
        }}
        noImageText="NoImage"
      />,
    );

    const badge = screen.getByText(CUSTOM_RARITY);
    expect(badge.className).toContain("bg-[color:var(--rarity-color)]");
    expect(badge.getAttribute("style")).toContain(`--rarity-color: ${CUSTOM_COLOR}`);
  });

  it("CardList（ダッシュボードのリスト表示）のバッジにも同じ配色を当てる", () => {
    // リスト表示はダッシュボードのカード一覧の既定形式。ここへ styles を
    // 渡し忘れると「サムネイルに切り替えた時だけ色が出る」非対称になる。
    render(<CardList cards={[baseCard]} rarityStyles={CUSTOM_STYLES} />);

    const badge = screen.getByText(CUSTOM_RARITY);
    expect(badge.className).toContain("bg-[color:var(--rarity-color)]");
    expect(badge.getAttribute("style")).toContain(`--rarity-color: ${CUSTOM_COLOR}`);
  });

  it("CardList は styles 未指定なら従来のプリセット色のままにする", () => {
    render(<CardList cards={[baseCard]} />);

    const badge = screen.getByText(CUSTOM_RARITY);
    expect(badge.className).toContain("bg-gray-500");
    expect(badge.getAttribute("style")).toBeNull();
  });
});
