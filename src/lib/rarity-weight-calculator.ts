export interface RarityWeightCardInput {
  id: string;
  rarity: string;
  is_active: boolean;
  // レアリティ内重み（デフォルト1.0=均等配分）
  intra_rarity_weight?: number;
}

export interface DropRateCalculationResult {
  id: string;
  dropRate: number;
}

function roundTo4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isValidPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * intra_rarity_weight を安全に number 化する。
 *
 * Supabase JS client は PostgreSQL の DECIMAL/NUMERIC を文字列で返す場合がある
 * (normalizeDropRate が drop_rate に対して存在するのと同じ理由。card-utils.ts
 * 参照)。intra_rarity_weight は NUMERIC 列のため同じ問題を持ち、文字列のまま
 * sumIntraWeightsByRarity の `+` に入ると数値加算ではなく文字列連結になって
 * 分母が壊れる(例: 0 + "2" + "3" → "023" → 23)。ここで一律に Number() 化する。
 * 型上は number でも実行時は string がありうる「生成型の嘘」への防御であり、
 * 不正値(NaN/0以下 — DBのCHECKで通常は発生しない)はデフォルトの 1.0 に倒す。
 */
function toIntraWeight(value: number | string | null | undefined): number {
  const n = Number(value ?? 1.0);
  return Number.isFinite(n) && n > 0 ? n : 1.0;
}

/**
 * カード群をレアリティごとにグルーピングし、各レアリティの intra_rarity_weight
 * 合計を集計する。calculateDropRates と computeEffectiveWeights はどちらも
 * 「(レアリティ目標%) × (このカードのintra_weight / 同レアリティ内intra_weight合計)」
 * という同一の分配ロジックを使うため、集計部分を共有ヘルパーとして切り出す
 * (Issue #579 #576フェーズ2 でリファクタ抽出)。
 *
 * 戻り値は rarity -> totalIntraWeight の Map。あるレアリティが cards に
 * 1件も存在しない場合はキー自体が存在しない(呼び出し側は Map.get の
 * undefined で「このレアリティはプールに存在しない」を判定する)。
 */
function sumIntraWeightsByRarity<T extends { rarity: string; intra_rarity_weight?: number | null }>(
  cards: T[]
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const card of cards) {
    const intraWeight = toIntraWeight(card.intra_rarity_weight);
    totals.set(card.rarity, (totals.get(card.rarity) ?? 0) + intraWeight);
  }
  return totals;
}

/**
 * Calculate drop_rate per active card based on rarity target percentages.
 *
 * Rules:
 * - Only active cards are recalculated.
 * - Existing card rarities are detected dynamically (no fixed rarity list).
 * - If a card rarity is missing/invalid in rarityWeights, the card drop rate is 0
 *   (excluded from gacha). A per-card equal fallback would let unconfigured
 *   rarities silently inflate the total well beyond the 100% the operator set,
 *   breaking the rarity-weight design. 0 keeps the configured totals intact.
 * - intra_rarity_weight controls distribution within a rarity (default 1.0 = equal share).
 *   Formula: card_rate = (rarity_pct / 100) * (card_intra_weight / sum_intra_weights_in_rarity)
 * - Result is rounded to 4 decimal places to match DECIMAL(5,4).
 */
export function calculateDropRates(
  cards: RarityWeightCardInput[],
  rarityWeights: Record<string, number>
): DropRateCalculationResult[] {
  const activeCards = cards.filter((card) => card.is_active);
  if (activeCards.length === 0) {
    return [];
  }

  // レアリティごとのintra_rarity_weight合計を集計
  const totalsByRarity = sumIntraWeightsByRarity(activeCards);

  return activeCards.map((card) => {
    const targetPercent = rarityWeights[card.rarity];
    const totalIntraWeight = totalsByRarity.get(card.rarity);

    // レアリティ重みが未設定/不正なカードは排出対象外(0%)。
    // 均等配分のフォールバックを行うと、運用者が設定した合計100%を
    // 未設定レアリティが押し上げてしまい、レアリティ重み設計が破綻するため。
    if (!isValidPercent(targetPercent) || !totalIntraWeight) {
      return { id: card.id, dropRate: 0 };
    }

    const intraWeight = toIntraWeight(card.intra_rarity_weight);
    // card_rate = (rarity_pct / 100) * (intra_weight / total_intra_weight_in_rarity)
    const dropRate = roundTo4((targetPercent / 100) * (intraWeight / totalIntraWeight));
    return { id: card.id, dropRate };
  });
}

export interface EffectiveWeightResult<T> {
  card: T;
  effectiveWeight: number;
}

/**
 * 抽選時に「パック内でのレアリティ自動配分」を実現するための実効重みを計算する
 * (Issue #579, #576 フェーズ2)。
 *
 * calculateDropRates と同じ分配式を使うが、以下の点が異なる:
 * - 対象は「抽選プール(pool)」であり、is_active によるフィルタは行わない。
 *   呼び出し側(GachaService.executeGacha)が渡す pool は既に
 *   `is_active = true` かつパックで絞り込み済みのカード集合であるため、
 *   ここで再フィルタすると「パック内に存在するがプールから外れたカード」が
 *   誤って母数計算に混ざる/混ざらないの二重管理になり事故りやすい。
 * - 結果は4桁丸めを行わない。抽選プールに閉じた実効重みは DECIMAL(5,4) の
 *   cards.drop_rate として永続化されず、浮動小数点のまま相対比で消費される
 *   (抽選側は selectWeightedCard、表示側は CardManager のパック別確率列と
 *   編集プレビューの overallPercent)ため、丸める理由が無い。ここで
 *   roundTo4 を掛けると、1枚あたりの実効重みが小さい構成
 *   (例: 5% のレアリティを 600 枚へ配分 → 1枚 0.0000833)で端数が丸め切られ、
 *   そのレアリティ全体の排出率が設計値から数%〜十数%ずれる。0.00005 未満に
 *   至っては 0 に丸まり、設定上は排出対象のカードが永久に当たらなくなる。
 *   (selectWeightedCard も以前は 1e-4 単位で量子化しており同じ歪みを持って
 *   いたが、そちらは浮動小数点方式へ修正済み。ここで丸めを復活させると
 *   その修正を無効化してしまう。)
 *
 * 計算式(設計 #576):
 *   effectiveWeight(card) = (rarityWeights[card.rarity] / 100)
 *     × (card.intra_rarity_weight ?? 1) / Σ(同レアリティのintra_rarity_weight in pool)
 *
 * レアリティ重み未設定/不正、またはそのレアリティのカードがプールに
 * 存在しない場合は 0 (calculateDropRatesと同じ理由: 均等フォールバックは
 * 運用者が設定した合計を壊すため)。
 *
 * プールにあるがrarityWeightsに未設定のレアリティが混在する場合、
 * 有効重みの合計は1(=100%)を下回る。selectWeightedCard は渡された
 * アイテムの重み比率だけで選択するため(絶対値としての100%基準を持たない)、
 * この「合計<1」は選択時に残りの重み同士の相対比率で自動的に
 * 再正規化される — 明示的な再正規化ロジックをここに書く必要はない。
 */
export function computeEffectiveWeights<
  T extends { rarity: string; intra_rarity_weight?: number | null }
>(pool: T[], rarityWeights: Record<string, number>): EffectiveWeightResult<T>[] {
  if (pool.length === 0) {
    return [];
  }

  const totalsByRarity = sumIntraWeightsByRarity(pool);

  return pool.map((card) => {
    const targetPercent = rarityWeights[card.rarity];
    const totalIntraWeight = totalsByRarity.get(card.rarity);

    if (!isValidPercent(targetPercent) || !totalIntraWeight) {
      return { card, effectiveWeight: 0 };
    }

    const intraWeight = toIntraWeight(card.intra_rarity_weight);
    const effectiveWeight = (targetPercent / 100) * (intraWeight / totalIntraWeight);
    return { card, effectiveWeight };
  });
}

/**
 * 配信者のレアリティ重み設定から、指定パック(packKey)に適用すべき
 * rarityWeights を解決する(Issue #579, #576 フェーズ2)。
 *
 * 戻り値が null の場合は「手動モード」を意味し、呼び出し側は
 * computeEffectiveWeights を使わず、従来どおり drop_rate をプール内で
 * 再正規化する挙動(normalizeDropRate + selectWeightedCard)を維持する。
 *
 * 解決ルール(#576設計を参照。詳細は各分岐のコメントを参照):
 * 1. rarityWeights が null または空オブジェクト → 手動モード → null を返す。
 *    calculateDropRates 側で「rarityWeightsが未設定/空 = 自動モード無効」と
 *    既に定義されている規約(00028/00029)をそのまま踏襲し、レアリティ自動
 *    モード自体が無効な配信者にパック別機能を適用しないようにする。
 * 2. scope === 'per_pack' かつ packRarityWeights[packKey] が有効な
 *    (空でない)オブジェクトとして存在する → そのパック専用の重みを返す。
 * 3. scope === 'per_pack' だが packKey のエントリが無い/空 →
 *    「エントリの無いパックはグローバル rarity_weights を継承する」という
 *    migration 00065 のコメントに明記されたアプリ層規約どおり、
 *    グローバル rarityWeights にフォールバックする。
 * 4. scope === 'global'、または scope が undefined/null/未知の値
 *    (rarity_weights_scope 列がデプロイ窓で欠落している場合を含む) →
 *    グローバル rarityWeights をそのまま返す。デプロイ窓を「機能無効」側
 *    ではなく「常に安全な全パック共通配分」側に倒すことで、列未デプロイ時に
 *    抽選が壊れる/拒否されることを防ぐ(このリポジトリの既存デプロイ窓
 *    フォールバック方針 — 例: isMissingCollectionNameColumn — と同じ考え方)。
 */
export function resolveRarityWeightsForPool(
  scope: string | null | undefined,
  rarityWeights: Record<string, number> | null | undefined,
  packRarityWeights: Record<string, Record<string, number>> | null | undefined,
  packKey: string
): Record<string, number> | null {
  // 手動モード: rarityWeights が null/undefined、または空オブジェクト({})。
  // {} は「全レアリティ重み未設定」ではなく「自動モード自体を使わない」を
  // 意味する既存規約(calculateDropRatesのテスト/00028/00029参照)。
  if (!rarityWeights || Object.keys(rarityWeights).length === 0) {
    return null;
  }

  if (scope === "per_pack") {
    const packEntry = packRarityWeights?.[packKey];
    if (packEntry && Object.keys(packEntry).length > 0) {
      return packEntry;
    }
    // このパックには上書きエントリが無い(または空) → グローバル継承
    return rarityWeights;
  }

  // scope === 'global'、またはデプロイ窓等で scope が undefined/null/
  // 未知の値の場合は、常にグローバル rarityWeights を使う。
  return rarityWeights;
}
