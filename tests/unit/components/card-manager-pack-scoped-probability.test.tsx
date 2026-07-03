import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { baseCard, renderCardManager } from "../../utils/card-manager-test-helpers";

vi.mock("@/lib/logger");

// Issue #580(#576 フェーズ3): 確率表示の統一(PR #575 の指摘の解消)。
//
// #565 まではパックフィルタ選択中の確率列を「フィルタ後の drop_rate 比」で
// 計算していたが、drop_rate は「配信者の全アクティブカード」を母数に自動
// 計算された値であり、パック内の実際のレアリティ構成比とズレることがある。
// このテストでは、パック外に同じレアリティのカードが存在することで
// 単純比率(旧実装)と computeEffectiveWeights ベース(新実装)の結果が
// 意図的に食い違う fixture を使い、新実装の値が表示されることを検証する。

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

const selectPackFilter = (value: string) => {
  fireEvent.change(screen.getByRole("combobox", { name: "カードパックで絞り込む" }), {
    target: { value },
  });
};

describe("CardManager pack-scoped probability in auto mode (Issue #580)", () => {
  // common: A(intra=1, in pack) + A2(intra=1, outside pack) => drop_rate は
  // ストリーマー全体のコモン内で 1:1 分配された値(50% * 1/2 = 25%→0.25相当)。
  // rare: B のみ(パック内)。パック内だけで見ると common/rare は 1枚ずつなので
  // 実際のパック抽選は 50%/50% になるが、旧実装(drop_rate単純比)は
  // 0.3:0.6=33.3%/66.7% になってしまう。
  const cards = [
    baseCard({ id: "a", name: "CardA", rarity: "common", collection_name: "weapons", intra_rarity_weight: 1, drop_rate: 0.3 }),
    baseCard({ id: "a2", name: "CardA2", rarity: "common", collection_name: null, intra_rarity_weight: 1, drop_rate: 0.3 }),
    baseCard({ id: "b", name: "CardB", rarity: "rare", collection_name: "weapons", intra_rarity_weight: 1, drop_rate: 0.6 }),
  ];

  it("shows computeEffectiveWeights-based probabilities (not the naive drop_rate ratio) when a pack filter is active", () => {
    renderCardManager(cards, {
      initialCardPackNames: ["weapons"],
      initialRarityWeights: { common: 50, rare: 50 },
      viewMode: "list",
    });

    selectPackFilter("weapons");

    // 正しい実効確率: コモン/レア、それぞれパック内1枚ずつ → 50%/50%
    expect(within(rowFor("CardA")).getByText("50.0%")).toBeInTheDocument();
    expect(within(rowFor("CardB")).getByText("50.0%")).toBeInTheDocument();
    // 旧実装(drop_rate単純比: 0.3:0.6)の値は出ない
    expect(screen.queryByText("33.3%")).not.toBeInTheDocument();
    expect(screen.queryByText("66.7%")).not.toBeInTheDocument();
  });

  it("falls back to the totalActiveWeight ratio when no pack filter is selected", () => {
    renderCardManager(cards, {
      initialCardPackNames: ["weapons"],
      initialRarityWeights: { common: 50, rare: 50 },
      viewMode: "list",
    });

    // フィルタ未選択時は従来通り: 0.3 : 0.3 : 0.6 の合計1.2に対する比率
    expect(within(rowFor("CardA")).getByText("25.0%")).toBeInTheDocument();
    expect(within(rowFor("CardA2")).getByText("25.0%")).toBeInTheDocument();
    expect(within(rowFor("CardB")).getByText("50.0%")).toBeInTheDocument();
  });

  it("keeps the simple drop_rate ratio unchanged for manual mode + pack filter", () => {
    renderCardManager(cards, {
      initialCardPackNames: ["weapons"],
      initialRarityWeights: {}, // 手動モード明示
      viewMode: "list",
    });

    selectPackFilter("weapons");

    // 手動モードは drop_rate がそのまま抽選重みなので、パック内の単純比率
    // (0.3 : 0.6 → 33.3% / 66.7%)のままで正しい(#579 の対象外)。
    expect(within(rowFor("CardA")).getByText("33.3%")).toBeInTheDocument();
    expect(within(rowFor("CardB")).getByText("66.7%")).toBeInTheDocument();
  });
});

describe("CardManager card-form preview: scope-aware pool label + probability (Issue #580)", () => {
  it("shows the pack pool label and a probability resolved from the pack's own weights (not the global ones)", () => {
    // X, Y はパック内(weapons)。Z はパック外(未分類) → プレビュー計算から
    // 除外されるべき。パック別重み(common:80%/rare:20%)はグローバル
    // (common:50%/rare:50%)と異なる値にして、正しくパック専用の重みが
    // 使われていることも同時に検証する。
    const cards = [
      baseCard({ id: "x", name: "X", rarity: "common", collection_name: "weapons", intra_rarity_weight: 1 }),
      baseCard({ id: "y", name: "Y", rarity: "rare", collection_name: "weapons", intra_rarity_weight: 1 }),
      baseCard({ id: "z", name: "Z", rarity: "common", collection_name: null, intra_rarity_weight: 1 }),
    ];

    renderCardManager(cards, {
      initialCardPackNames: ["weapons"],
      initialRarityWeights: { common: 50, rare: 50 },
      initialRarityWeightsScope: "per_pack",
      initialPackRarityWeights: { weapons: { common: 80, rare: 20 } },
    });

    fireEvent.click(screen.getByRole("button", { name: "新規カード追加" }));

    const packSelect = document.querySelector('select[name="collectionName"]') as HTMLSelectElement;
    fireEvent.change(packSelect, { target: { value: "weapons" } });

    // ラベル: このカードは "weapons" パック内の確率を基準にしている
    expect(screen.getByText("「weapons」パック内での確率")).toBeInTheDocument();

    // rarity は初期値 "common"、intraRarityWeight は初期値 1.0。
    // パック内プール = {X(common,1), Y(rare,1), 編集中カード(common,1)}
    // (Zは別パックなので除外)。パック専用重み{common:80,rare:20}を使うと:
    //   common合計intra = X(1) + 編集中(1) = 2 → 編集中のシェアは1/2=50%
    //   effectiveWeight(編集中) = 0.8 * (1/2) = 0.4
    //   effectiveWeight(X) = 0.8 * (1/2) = 0.4
    //   effectiveWeight(Y) = 0.2 * (1/1) = 0.2
    //   合計 = 1.0 → 編集中カードの全体排出率 = 0.4/1.0 = 40.0%
    // (グローバル重み50/50を使った場合は25.0%になり、値が異なるため
    //  パック専用重みが正しく使われていることの検証にもなる)
    expect(screen.getByText("コモン内:")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("40.0%")).toBeInTheDocument();
  });
});
