"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { Card, Rarity } from "@/types/database";
import { RARITIES } from "@/lib/constants";
import { formatRarityLabel, getRarityDisplayInfo } from "@/lib/rarity";
import { logger } from "@/lib/logger";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import { cardMatchesPackKey } from "@/lib/collection-packs";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

interface DropRateAutoModeContentProps {
  cards: Card[];
  streamerId: string;
  rarityWeights: Record<string, number>;
  // カスタムレアリティ名（カード未使用でも重み設定欄に表示するため）
  customRarities: string[];
  // Issue #580(#576 フェーズ3): パック別レアリティ配分UI用のプロップ群。
  // 事前登録カードパック名（空配列ならスコープ切替UI自体を出さない）。
  cardPackNames: string[];
  // 「デフォルト」(未分類)パックの表示名オーバーライド
  defaultPackName: string | null;
  // レアリティ重みのスコープ('global'|'per_pack')
  rarityWeightsScope: "global" | "per_pack";
  // パック別レアリティ重みの上書きマップ（null = エントリなし）
  packRarityWeights: Record<string, Record<string, number>> | null;
  // 保存成功後、サーバーの永続値でスコープ/パック別重みを再同期するコールバック
  onPackWeightsApply: (
    scope: "global" | "per_pack",
    packRarityWeights: Record<string, Record<string, number>>
  ) => void;
  onCardsSave: (updatedCards: Card[]) => void;
  onRarityWeightsApply: (
    w: Record<string, number> | null,
    c: Card[] | null
  ) => void;
  onSwitchToManualMode: () => void;
  onClose: () => void;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Issue #580: 2つのパック別重みマップ(ネストしたRecord<string,Record<string,number>>)
 * が実質的に等しいかどうかを判定する。保存ボタンの活性化判定(scopeOrPackHasChanges)
 * に使う。数値比較は他の重み比較と同じ許容誤差(0.001)を用いる。
 */
function packWeightsEqual(
  a: Record<string, Record<string, number>>,
  b: Record<string, Record<string, number>>
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    const aEntry = a[key];
    const bEntry = b[key];
    if (!bEntry) return false;

    const aEntryKeys = Object.keys(aEntry);
    const bEntryKeys = Object.keys(bEntry);
    if (aEntryKeys.length !== bEntryKeys.length) return false;

    for (const rarityKey of aEntryKeys) {
      if (!Object.prototype.hasOwnProperty.call(bEntry, rarityKey)) return false;
      if (Math.abs(aEntry[rarityKey] - bEntry[rarityKey]) > 0.001) return false;
    }
  }

  return true;
}

interface RarityWeightFieldsProps {
  rarityKeys: string[];
  values: Record<string, number>;
  activeCounts: Map<string, number>;
  getRarityLabel: (rarity: string) => string;
  activeCardsSuffix: string;
  noCardsLabel: string;
  // true の場合、値を編集不可の静的表示にする(パックがグローバル設定を
  // 継承中のときのベースライン表示に使用)。
  readOnly?: boolean;
  onChange?: (rarity: string, value: number) => void;
}

/**
 * Issue #580(#576 フェーズ3): レアリティ別%スライダー行の一覧UI。
 * グローバル配分編集・パック別配分編集(専用設定/継承中の読み取り専用表示)の
 * 3箇所で同一マークアップが必要になったため、共通コンポーネントとして抽出した
 * (以前は「レアリティ別設定」タブ内に1箇所だけ直書きしていた)。
 */
function RarityWeightFields({
  rarityKeys,
  values,
  activeCounts,
  getRarityLabel,
  activeCardsSuffix,
  noCardsLabel,
  readOnly = false,
  onChange,
}: RarityWeightFieldsProps) {
  return (
    <div className="space-y-3">
      {rarityKeys.map((rarity) => {
        const count = activeCounts.get(rarity) || 0;
        const value = values[rarity] ?? 0;

        return (
          <div key={rarity} className="rounded-lg bg-gray-700 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-white">
                {getRarityLabel(rarity)}
              </span>
              <span className="text-xs text-gray-400">
                {count > 0 ? `${count}${activeCardsSuffix}` : noCardsLabel}
              </span>
            </div>
            {readOnly ? (
              <div className="flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-600">
                  <div
                    className="h-2 rounded-full bg-gray-500"
                    style={{ width: `${Math.min(value, 100)}%` }}
                  />
                </div>
                <span className="w-16 text-right text-sm text-gray-300">
                  {value.toFixed(1)}%
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={0.1}
                  value={value}
                  onChange={(event) => onChange?.(rarity, Number(event.target.value))}
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-gray-600 accent-purple-500"
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={value}
                  onChange={(event) => onChange?.(rarity, Number(event.target.value))}
                  className="w-20 rounded bg-gray-600 px-2 py-1 text-right text-sm text-white"
                />
                <span className="w-6 text-sm text-gray-400">%</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * DropRateAutoModeContent - 自動モード用の排出確率設定コンテンツ
 *
 * タブ1（レアリティ別設定）: レアリティごとの%スライダー+数値入力
 * タブ2（カードごとの調整）: intra_rarity_weightスライダー + 確率プレビュー
 */
export default function DropRateAutoModeContent({
  cards,
  streamerId,
  rarityWeights,
  customRarities,
  cardPackNames,
  defaultPackName,
  rarityWeightsScope,
  packRarityWeights,
  onPackWeightsApply,
  onCardsSave,
  onRarityWeightsApply,
  onSwitchToManualMode,
  onClose,
}: DropRateAutoModeContentProps) {
  const t = useTranslations("cardManager");
  const tRarity = useTranslations("rarity");
  const tCommon = useTranslations("common");
  const tRarityProb = useTranslations("rarityProbability");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6c: ダッシュボード共有Context経由のmaintenance状態。
  // 保存のたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  // Issue #580: パックが1件も登録されていない配信者にはスコープ切替UI自体を
  // 出さない(デフォルトパック=グローバルなので、切替が意味を持たない)。
  const hasPacks = cardPackNames.length > 0;

  const [activeTab, setActiveTab] = useState<"rarity" | "perCard">("rarity");
  const [showHelp, setShowHelp] = useState(false);

  // === タブ1: レアリティ別設定 state ===
  const [draftWeights, setDraftWeights] = useState<Record<string, number>>(
    () => {
      const initial: Record<string, number> = {};
      for (const [key, value] of Object.entries(rarityWeights)) {
        initial[key] = clampPercent(value);
      }
      return initial;
    }
  );
  const [raritySaving, setRaritySaving] = useState(false);
  const [rarityMessage, setRarityMessage] = useState<string | null>(null);
  const [rarityError, setRarityError] = useState<string | null>(null);

  // === タブ1: パック別配分（Issue #580, #576 フェーズ3）state ===
  // 配分スコープのドラフト。保存ボタンを押すまでDBへは反映しない
  // (既存のレアリティ%編集と同じ「明示的な保存」フローに揃える)。
  const [draftScope, setDraftScope] = useState<"global" | "per_pack">(rarityWeightsScope);
  // パック別上書きマップのドラフト。キーの無いパックはグローバルを継承する
  // (#578 のアプリ層規約)。null(エントリなし)は空オブジェクトとして扱う。
  const [packWeightsDraft, setPackWeightsDraft] = useState<Record<string, Record<string, number>>>(
    () => packRarityWeights ?? {}
  );
  // パック別配分タブで現在選択中のパック。デフォルト(未分類疑似パック)から開始する。
  const [selectedPackKey, setSelectedPackKey] = useState<string>(DEFAULT_PACK_SENTINEL);

  // === タブ2: カードごとの調整 state ===
  const [localIntraWeights, setLocalIntraWeights] = useState<
    Map<string, number>
  >(new Map());
  const [perCardSaving, setPerCardSaving] = useState(false);

  const activeCards = useMemo(
    () => cards.filter((card) => card.is_active),
    [cards]
  );

  // レアリティキー一覧の計算
  const rarityKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const rarity of RARITIES) keys.add(rarity.value);
    for (const card of cards) keys.add(card.rarity);
    for (const key of Object.keys(rarityWeights)) keys.add(key);
    for (const key of customRarities) keys.add(key);

    const baseOrder = RARITIES.map((rarity) => rarity.value) as string[];
    const extras = Array.from(keys)
      .filter((key) => !baseOrder.includes(key))
      .sort();
    return [...baseOrder.filter((key) => keys.has(key)), ...extras];
  }, [cards, rarityWeights, customRarities]);

  // アクティブカード数（レアリティ別）
  const activeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      if (!card.is_active) continue;
      counts.set(card.rarity, (counts.get(card.rarity) || 0) + 1);
    }
    return counts;
  }, [cards]);

  // rarityWeightsプロップの変化時のみdraftをリセット
  const prevRarityWeightsRef = useRef(rarityWeights);
  useEffect(() => {
    if (prevRarityWeightsRef.current === rarityWeights) return;
    prevRarityWeightsRef.current = rarityWeights;

    const nextDraft: Record<string, number> = {};
    for (const key of rarityKeys) {
      nextDraft[key] = clampPercent(rarityWeights[key] ?? 0);
    }
    setDraftWeights(nextDraft);
  }, [rarityWeights, rarityKeys]);

  // カスタムレアリティ追加時の未登録キー初期化。
  // rarityKeys にカード由来の新規レアリティが現れたとき、draftWeights に
  // 当該キーを 0 で先行登録する。これをしないと、新キーが入力欄に 0 表示
  // される一方で合計には反映されず、「合計100%」制約と実表示が乖離して
  // 保存できなくなる（カスタムレアリティ追加でUI制約が破綻する）ため。
  useEffect(() => {
    setDraftWeights((prev) => {
      const missingKeys = rarityKeys.filter(
        (key) => !Object.prototype.hasOwnProperty.call(prev, key)
      );
      if (missingKeys.length === 0) return prev;

      const next = { ...prev };
      for (const key of missingKeys) {
        next[key] = clampPercent(rarityWeights[key] ?? 0);
      }
      return next;
    });
  }, [rarityKeys, rarityWeights]);

  // レアリティ別合計
  const rarityTotal = useMemo(() => {
    return Object.values(draftWeights).reduce((sum, value) => sum + value, 0);
  }, [draftWeights]);
  const isRarityTotalValid = Math.abs(rarityTotal - 100) <= 0.001;

  // === パック別配分（Issue #580） ===
  // 選択中パック内のアクティブカード数（レアリティ別）。継承中の読み取り専用
  // ベースライン表示でも「このパックに何枚あるか」を見せるため、専用/継承の
  // どちらの表示でも同じマップを使う。
  const packActiveCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      if (!card.is_active) continue;
      if (!cardMatchesPackKey(card.collection_name, selectedPackKey)) continue;
      counts.set(card.rarity, (counts.get(card.rarity) || 0) + 1);
    }
    return counts;
  }, [cards, selectedPackKey]);

  const selectedPackHasEntry = Object.prototype.hasOwnProperty.call(
    packWeightsDraft,
    selectedPackKey
  );
  const selectedPackWeights = useMemo(
    () => packWeightsDraft[selectedPackKey] ?? {},
    [packWeightsDraft, selectedPackKey]
  );
  const selectedPackTotal = useMemo(
    () => Object.values(selectedPackWeights).reduce((sum, value) => sum + value, 0),
    [selectedPackWeights]
  );
  const isSelectedPackTotalValid = Math.abs(selectedPackTotal - 100) <= 0.001;

  // 送信対象になる全パックエントリが合計100%かどうか（保存ボタンの活性判定用。
  // 選択中でないパックに不正な入力が残っていても送信してしまうため、
  // 全エントリを検証する）。
  const arePackWeightsValid = useMemo(
    () =>
      Object.values(packWeightsDraft).every(
        (entry) => Math.abs(Object.values(entry).reduce((sum, value) => sum + value, 0) - 100) <= 0.001
      ),
    [packWeightsDraft]
  );

  const scopeHasChanges = draftScope !== rarityWeightsScope;
  const packWeightsHasChanges = useMemo(
    () => !packWeightsEqual(packWeightsDraft, packRarityWeights ?? {}),
    [packWeightsDraft, packRarityWeights]
  );
  // hasPacks でない配信者はスコープUI自体が無いため、変更判定にも含めない。
  const scopeOrPackHasChanges = hasPacks && (scopeHasChanges || packWeightsHasChanges);

  const handleMakePackSpecific = () => {
    setPackWeightsDraft((prev) => ({ ...prev, [selectedPackKey]: { ...draftWeights } }));
  };

  const handleRevertToInherit = () => {
    setPackWeightsDraft((prev) => {
      const next = { ...prev };
      delete next[selectedPackKey];
      return next;
    });
  };

  const updateSelectedPackWeight = (rarity: string, value: number) => {
    const nextValue = clampPercent(value);
    setPackWeightsDraft((prev) => ({
      ...prev,
      [selectedPackKey]: { ...prev[selectedPackKey], [rarity]: nextValue },
    }));
  };

  // カードごと: intra weight初期化
  useEffect(() => {
    const initial = new Map<string, number>();
    activeCards.forEach((card) => {
      initial.set(card.id, card.intra_rarity_weight ?? 1.0);
    });
    setLocalIntraWeights(initial);
  }, [activeCards]);

  // カードごと: 変更チェック
  const perCardHasChanges = useMemo(() => {
    for (const card of activeCards) {
      const localWeight = localIntraWeights.get(card.id);
      const originalWeight = card.intra_rarity_weight ?? 1.0;
      if (
        localWeight !== undefined &&
        Math.abs(localWeight - originalWeight) > 0.001
      ) {
        return true;
      }
    }
    return false;
  }, [activeCards, localIntraWeights]);

  // カードごと: 変更カードID
  const modifiedCardIds = useMemo(() => {
    const ids = new Set<string>();
    for (const card of activeCards) {
      const localWeight = localIntraWeights.get(card.id);
      const originalWeight = card.intra_rarity_weight ?? 1.0;
      if (
        localWeight !== undefined &&
        Math.abs(localWeight - originalWeight) > 0.001
      ) {
        ids.add(card.id);
      }
    }
    return ids;
  }, [activeCards, localIntraWeights]);

  // カードごと: レアリティ内合計
  const rarityIntraTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const card of activeCards) {
      const weight =
        localIntraWeights.get(card.id) ?? (card.intra_rarity_weight ?? 1.0);
      const current = totals.get(card.rarity) ?? 0;
      totals.set(card.rarity, current + weight);
    }
    return totals;
  }, [activeCards, localIntraWeights]);

  // レアリティ別: draftWeightsの変更チェック
  const rarityHasChanges = useMemo(() => {
    for (const key of rarityKeys) {
      const draft = draftWeights[key] ?? 0;
      const original = rarityWeights[key] ?? 0;
      if (Math.abs(draft - original) > 0.001) return true;
    }
    return false;
  }, [draftWeights, rarityWeights, rarityKeys]);

  // 両タブの変更を常にチェック（タブ切替後のクローズでも確認ダイアログが出るように）
  // Issue #580: スコープ切替/パック別配分の未保存変更も含める。
  const hasAnyChanges = rarityHasChanges || perCardHasChanges || scopeOrPackHasChanges;

  const getRarityLabel = (rarity: string): string => formatRarityLabel(rarity, tRarity);

  const getRarityInfo = (rarity: Rarity) => getRarityDisplayInfo(rarity);

  // レアリティ別%の入力欄で使う「n枚」「0枚」ラベル（RarityWeightFieldsへ渡す）
  const activeCardsSuffix = tRarityProb("activeCards");
  const noCardsLabel = tRarityProb("noCards");

  // === レアリティ別: 保存 ===
  // レアリティ保存後、サーバーがカードのdrop_rateを再計算するため
  // カードごとタブの未保存weight変更は意味を失う → 確認してからリセット
  //
  // Issue #580(#576 フェーズ3): hasPacks の配信者は、グローバル配分
  // (draftWeights)に加えて配分スコープ(draftScope)とパック別上書きマップ
  // (packWeightsDraft)も同じ保存ボタンで一括送信する(モーダルの既存「明示的
  // 保存」フローに揃える方針)。packRarityWeights は full-map-replace APIのため、
  // 変更が無くても常に現在のドラフト全体を送る(既存 packRarityWeights との
  // 差分計算はしない)。
  const saveRarityWeights = async () => {
    if (perCardHasChanges && !confirm(t("batchDropRate.confirmClose"))) return;
    if (!isRarityTotalValid) {
      setRarityMessage(null);
      setRarityError(tRarityProb("totalWarning"));
      return;
    }
    if (hasPacks && !arePackWeightsValid) {
      setRarityMessage(null);
      setRarityError(t("dropRateSettings.packTotalWarning"));
      return;
    }
    // #694 Stage 6c: Saveボタン自体はdisableしているが、CardManager.handleSubmit
    // と同じ方針で送信経路の先頭でも二重にガードする。
    if (isMaintenanceBlocked) {
      setRarityMessage(null);
      setRarityError(tMaintenance("writeDisabled"));
      return;
    }
    setRaritySaving(true);
    setRarityMessage(null);
    setRarityError(null);

    try {
      const body: {
        streamerId: string;
        rarityWeights: Record<string, number>;
        rarityWeightsScope?: "global" | "per_pack";
        packRarityWeights?: Record<string, Record<string, number>>;
      } = {
        streamerId,
        rarityWeights: draftWeights,
      };
      if (hasPacks) {
        body.rarityWeightsScope = draftScope;
        body.packRarityWeights = packWeightsDraft;
      }

      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(body),
      });

      const data = await response.json();
      if (!response.ok) {
        // maintenance mode による503拒否ならサーバーの案内文言を優先する。
        const maintenanceError = parseMaintenanceError(response, data);
        setRarityError(maintenanceError?.message || data.error || tRarityProb("totalWarning"));
        return;
      }

      const recalculatedCards = Array.isArray(data.recalculatedCards)
        ? (data.recalculatedCards as Card[])
        : null;
      onRarityWeightsApply(draftWeights, recalculatedCards);

      if (hasPacks) {
        if (data.rarityWeightsScopeSkippedDeployWindow || data.packRarityWeightsSkippedDeployWindow) {
          // デプロイ窓で列自体への書き込みが見送られたケース。rarityWeights
          // (グローバル配分)は保存できているが、スコープ/パック別配分は
          // 反映されていないため、GachaSoundSettings.saveRules と同じ
          // パターンで案内する（成功扱いにはしない）。
          //
          // ここで return し、下の tRarityProb("saved") 成功メッセージを
          // 出さない: 両方のメッセージが同時に表示されると「保存できた」と
          // 「保存できなかった」が矛盾して見え、ユーザーがスコープ/パック別
          // 設定は実際には反映されていないことを見落としかねないため
          // (自己レビューで発見: GachaSoundSettings.saveRules は同種のケースで
          // 常に return false し、成功メッセージを一切出さない)。
          setRarityError(t("dropRateSettings.packScopeDeployWindow"));
          return;
        }

        // packRarityWeights は常にエコーバックされる(サーバー側でプレミアム
        // ゲート等により加工されうるため)。応答に無ければ防御的に送信値へ
        // フォールバックする。rarityWeightsScope はサーバー側の加工シナリオが
        // 無いためエコー不要（送信値がそのまま正）。
        const persistedPackWeights = (
          data.packRarityWeights ?? packWeightsDraft
        ) as Record<string, Record<string, number>>;
        setPackWeightsDraft(persistedPackWeights);
        onPackWeightsApply(draftScope, persistedPackWeights);
      }

      setRarityMessage(tRarityProb("saved"));
    } catch (saveError) {
      logger.error("Failed to save rarity weights:", saveError);
      setRarityError(tRarityProb("totalWarning"));
    } finally {
      setRaritySaving(false);
    }
  };

  // === カードごと: 全リセット ===
  const handleResetAll = () => {
    setLocalIntraWeights((prev) => {
      const next = new Map(prev);
      activeCards.forEach((card) => {
        next.set(card.id, 1.0);
      });
      return next;
    });
  };

  // === カードごと: 保存 ===
  // カードごと保存時にレアリティタブ(グローバル配分/スコープ切替/パック別配分)の
  // 未保存変更があれば確認（保存完了後にモーダルが閉じるため、ドラフトが消失する）。
  // Issue #580自己レビューで発見: scopeOrPackHasChanges を見落とすと、
  // パック別配分だけを編集した状態でこちらのタブから保存した場合に
  // 確認なしでドラフトが破棄されてしまう(hasAnyChangesは正しく含めているのに
  // ここだけ旧来のrarityHasChangesのみだった)。
  const handlePerCardSave = async () => {
    if (!perCardHasChanges) return;
    if ((rarityHasChanges || scopeOrPackHasChanges) && !confirm(t("batchDropRate.confirmClose"))) return;
    // #694 Stage 6c: Saveボタン自体はdisableしているが、送信経路の先頭でも
    // 二重にガードする（saveRarityWeightsと同じ方針）。
    if (isMaintenanceBlocked) {
      alert(tMaintenance("writeDisabled"));
      return;
    }
    setPerCardSaving(true);
    try {
      const updates: Array<{
        id: string;
        dropRate: number;
        intraRarityWeight: number;
      }> = [];
      for (const card of activeCards) {
        const localWeight = localIntraWeights.get(card.id);
        const originalWeight = card.intra_rarity_weight ?? 1.0;
        if (
          localWeight !== undefined &&
          Math.abs(localWeight - originalWeight) > 0.001
        ) {
          updates.push({
            id: card.id,
            dropRate: card.drop_rate,
            intraRarityWeight: localWeight,
          });
        }
      }

      if (updates.length === 0) {
        onClose();
        return;
      }

      const response = await fetch("/api/cards/batch-update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ streamerId, updates }),
      });

      if (!response.ok) {
        const error = await response.json();
        // maintenance mode による503拒否時、error.error はオブジェクト形状
        // (`{code, message, ...}`) のため、そのままthrowすると"[object Object]"
        // 表示になる（CardManagerの既知バグと同種）。parseMaintenanceErrorで
        // 先に判定する。
        const maintenanceError = parseMaintenanceError(response, error);
        throw new Error(maintenanceError?.message || (typeof error.error === "string" ? error.error : t("batchDropRate.saveFailed")));
      }

      const result = await response.json();
      if (result.cards) {
        let allUpdatedCards = result.cards as Card[];
        if (Array.isArray(result.recalculatedCards)) {
          const recalculatedMap = new Map(
            (result.recalculatedCards as Card[]).map((c) => [c.id, c])
          );
          allUpdatedCards = allUpdatedCards.map(
            (c) => recalculatedMap.get(c.id) || c
          );
          for (const rc of result.recalculatedCards as Card[]) {
            if (!allUpdatedCards.some((c) => c.id === rc.id)) {
              allUpdatedCards.push(rc);
            }
          }
        }
        onCardsSave(allUpdatedCards);
      }
      onClose();
    } catch (error) {
      logger.error("Failed to batch update drop rates:", error);
      alert(
        error instanceof Error ? error.message : t("batchDropRate.saveFailed")
      );
    } finally {
      setPerCardSaving(false);
    }
  };

  // 未保存変更がある場合は確認ダイアログ
  const handleClose = () => {
    if (hasAnyChanges && !confirm(t("batchDropRate.confirmClose"))) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={handleClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-white">
                {t("dropRateSettings.title")}
              </h3>
              <button
                type="button"
                onClick={() => setShowHelp(true)}
                className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-gray-500 text-gray-400 hover:text-gray-200 hover:border-gray-300 text-xs leading-none transition-colors shrink-0"
                aria-label={tRarityProb("help.title")}
              >
                ?
              </button>
            </div>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-white"
              aria-label="Close"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {isMaintenanceBlocked && (
            <p className="mt-3 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
          )}

          {/* タブ */}
          <div className="mt-4 flex border-b border-gray-700">
            <button
              onClick={() => setActiveTab("rarity")}
              className={`px-4 py-2 text-sm font-medium transition ${
                activeTab === "rarity"
                  ? "text-purple-400 border-b-2 border-purple-400"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {t("dropRateSettings.tabRarity")}
            </button>
            <button
              onClick={() => setActiveTab("perCard")}
              className={`px-4 py-2 text-sm font-medium transition ${
                activeTab === "perCard"
                  ? "text-purple-400 border-b-2 border-purple-400"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {t("dropRateSettings.tabPerCard")}
            </button>
          </div>

          {/* サマリーバー（カードごとタブ時のみ） */}
          {activeTab === "perCard" && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-sm">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-gray-400">
                    {t("batchDropRate.activeCards")}:
                  </span>
                  <span className="text-white font-medium">
                    {activeCards.length}
                  </span>
                </div>
                {perCardHasChanges && (
                  <>
                    <div className="h-4 w-px bg-gray-600" />
                    <div className="flex items-center gap-2">
                      <span className="text-yellow-400">
                        {modifiedCardIds.size}{" "}
                        {t("batchDropRate.cardsModified")}
                      </span>
                    </div>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={handleResetAll}
                className="rounded-lg border border-orange-500 px-3 py-1 text-sm text-orange-400 hover:bg-orange-500 hover:text-white transition"
              >
                {t("batchDropRate.resetAll")}
              </button>
            </div>
          )}
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "rarity" ? (
            /* === タブ1: レアリティ別設定 === */
            <div className="space-y-4">
              {/* Issue #580(#576 フェーズ3): 配分スコープ切替。パックが
                  1件も無い配信者には出さない(デフォルトパック=グローバルで
                  意味を持たないため)。 */}
              {hasPacks && (
                <div className="rounded-lg bg-gray-700/60 p-3">
                  <p className="mb-2 text-sm font-medium text-gray-200">
                    {t("dropRateSettings.scopeLabel")}
                  </p>
                  <div
                    role="radiogroup"
                    aria-label={t("dropRateSettings.scopeLabel")}
                    className="inline-flex overflow-hidden rounded-lg border border-gray-600"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draftScope === "global"}
                      onClick={() => setDraftScope("global")}
                      className={`px-3 py-1.5 text-sm transition ${
                        draftScope === "global"
                          ? "bg-purple-600 text-white"
                          : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                      }`}
                    >
                      {t("dropRateSettings.scopeGlobal")}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draftScope === "per_pack"}
                      onClick={() => setDraftScope("per_pack")}
                      className={`px-3 py-1.5 text-sm transition ${
                        draftScope === "per_pack"
                          ? "bg-purple-600 text-white"
                          : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                      }`}
                    >
                      {t("dropRateSettings.scopePerPack")}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-gray-400">
                    {draftScope === "global"
                      ? t("dropRateSettings.scopeGlobalHint")
                      : t("dropRateSettings.scopePerPackHint")}
                  </p>
                </div>
              )}

              {hasPacks && draftScope === "per_pack" ? (
                <>
                  {/* パック選択 */}
                  <div>
                    <label
                      htmlFor="drop-rate-pack-select"
                      className="mb-1 block text-sm text-gray-300"
                    >
                      {t("dropRateSettings.packSelectLabel")}
                    </label>
                    <select
                      id="drop-rate-pack-select"
                      value={selectedPackKey}
                      onChange={(event) => setSelectedPackKey(event.target.value)}
                      className="w-full rounded-lg bg-gray-700 px-3 py-2 text-sm text-white border border-gray-600"
                    >
                      <option value={DEFAULT_PACK_SENTINEL}>
                        {defaultPackName ?? t("cardPackModal.defaultName")}
                      </option>
                      {cardPackNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {selectedPackHasEntry ? (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-sm text-gray-300">
                            {tRarityProb("total")}:{" "}
                            <span className="font-medium text-white">
                              {selectedPackTotal.toFixed(1)}%
                            </span>
                          </span>
                          {!isSelectedPackTotalValid && (
                            <span className="rounded bg-yellow-500/20 px-2 py-1 text-xs text-yellow-300">
                              {tRarityProb("totalWarning")}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={handleRevertToInherit}
                          className="text-xs text-gray-400 underline hover:text-white"
                        >
                          {t("dropRateSettings.revertToInherit")}
                        </button>
                      </div>
                      <RarityWeightFields
                        rarityKeys={rarityKeys}
                        values={selectedPackWeights}
                        activeCounts={packActiveCounts}
                        getRarityLabel={getRarityLabel}
                        activeCardsSuffix={activeCardsSuffix}
                        noCardsLabel={noCardsLabel}
                        onChange={updateSelectedPackWeight}
                      />
                    </>
                  ) : (
                    <>
                      <div className="flex items-center justify-between gap-3 rounded-lg bg-gray-700/40 px-3 py-2">
                        <span className="text-sm text-gray-300">
                          {t("dropRateSettings.inheritingGlobal")}
                        </span>
                        <button
                          type="button"
                          onClick={handleMakePackSpecific}
                          className="rounded-lg border border-purple-500 px-3 py-1 text-xs text-purple-300 transition hover:bg-purple-500 hover:text-white"
                        >
                          {t("dropRateSettings.makePackSpecific")}
                        </button>
                      </div>
                      <RarityWeightFields
                        rarityKeys={rarityKeys}
                        values={draftWeights}
                        activeCounts={packActiveCounts}
                        getRarityLabel={getRarityLabel}
                        activeCardsSuffix={activeCardsSuffix}
                        noCardsLabel={noCardsLabel}
                        readOnly
                      />
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm text-gray-300">
                      {tRarityProb("total")}:{" "}
                      <span className="font-medium text-white">
                        {rarityTotal.toFixed(1)}%
                      </span>
                    </span>
                    {!isRarityTotalValid && (
                      <span className="rounded bg-yellow-500/20 px-2 py-1 text-xs text-yellow-300">
                        {tRarityProb("totalWarning")}
                      </span>
                    )}
                  </div>
                  <RarityWeightFields
                    rarityKeys={rarityKeys}
                    values={draftWeights}
                    activeCounts={activeCounts}
                    getRarityLabel={getRarityLabel}
                    activeCardsSuffix={activeCardsSuffix}
                    noCardsLabel={noCardsLabel}
                    onChange={(rarity, value) => {
                      const nextValue = clampPercent(value);
                      setDraftWeights((prev) => ({
                        ...prev,
                        [rarity]: nextValue,
                      }));
                    }}
                  />
                </>
              )}

              {rarityMessage && (
                <p className="text-sm text-green-400">{rarityMessage}</p>
              )}
              {rarityError && (
                <p className="text-sm text-red-400">{rarityError}</p>
              )}
            </div>
          ) : (
            /* === タブ2: カードごとの調整 === */
            <div>
              {activeCards.length === 0 ? (
                <p className="text-center text-gray-400">
                  {t("batchDropRate.noActiveCards")}
                </p>
              ) : (
                <div className="space-y-3">
                  {activeCards.map((card) => {
                    const rarityInfo = getRarityInfo(card.rarity);
                    const currentWeight =
                      localIntraWeights.get(card.id) ??
                      (card.intra_rarity_weight ?? 1.0);
                    const isModified = modifiedCardIds.has(card.id);

                    // 確率プレビュー: draftWeightsを使用してレアリティ編集を即反映
                    // card_rate = (rarity_pct / 100) * (intra_weight / total_intra)
                    const targetPercent = draftWeights[card.rarity] ?? 0;
                    const sameRarityTotal =
                      rarityIntraTotals.get(card.rarity) ?? 0;
                    const overallPercent =
                      sameRarityTotal > 0
                        ? (targetPercent / 100) *
                          (currentWeight / sameRarityTotal) *
                          100
                        : 0;

                    return (
                      <div
                        key={card.id}
                        className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg p-3 transition ${
                          isModified
                            ? "bg-yellow-900/30 border border-yellow-600/50"
                            : "bg-gray-700"
                        }`}
                      >
                        {/* カード情報 */}
                        <div className="flex items-center gap-3 min-w-0 sm:w-48 shrink-0">
                          <div className="w-10 h-10 rounded bg-gray-600 overflow-hidden shrink-0">
                            {card.image_url ? (
                              <Image
                                src={getOptimizedImageUrl(
                                  card.image_url,
                                  "icon"
                                )}
                                alt={card.name}
                                width={40}
                                height={40}
                                className="w-full h-full object-cover"
                                unoptimized
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-500 text-xs">
                                {tCommon("noImage")}
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-white truncate">
                              {card.name}
                            </p>
                            <span
                              className={`inline-block rounded-full px-2 py-0.5 text-xs text-white ${rarityInfo.color}`}
                            >
                              {getRarityLabel(card.rarity)}
                            </span>
                          </div>
                        </div>

                        {/* intra-rarity weightスライダー */}
                        <div className="flex-1 flex flex-col sm:flex-row items-start sm:items-center gap-3">
                          <div className="flex-1 w-full">
                            <input
                              type="range"
                              min="0.1"
                              max="10"
                              step="0.1"
                              value={currentWeight}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value);
                                setLocalIntraWeights((prev) => {
                                  const next = new Map(prev);
                                  next.set(card.id, val);
                                  return next;
                                });
                              }}
                              className="w-full"
                            />
                          </div>
                          {targetPercent > 0 && (
                            <div className="flex items-center gap-2 text-sm shrink-0">
                              <span className="text-xs text-gray-500">
                                {t("batchDropRate.overallDropRate")}
                              </span>
                              <span
                                className={`font-medium ${isModified ? "text-yellow-400" : "text-green-400"}`}
                              >
                                {overallPercent.toFixed(1)}%
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="p-6 border-t border-gray-700 bg-gray-800/50">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                // 未保存変更がある場合は確認（モード切替で変更が失われるため）
                if (hasAnyChanges && !confirm(t("batchDropRate.confirmClose"))) return;
                onSwitchToManualMode();
              }}
              disabled={isMaintenanceBlocked}
              title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
              className="text-sm text-gray-400 hover:text-white transition text-left disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("dropRateSettings.switchToManual")}
            </button>
            <div className="flex justify-end gap-3">
              <button
                onClick={handleClose}
                className="rounded-lg border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-700"
              >
                {tCommon("cancel")}
              </button>
              {activeTab === "rarity" ? (
                <button
                  onClick={saveRarityWeights}
                  disabled={
                    !(rarityHasChanges || scopeOrPackHasChanges) ||
                    raritySaving ||
                    !isRarityTotalValid ||
                    (hasPacks && !arePackWeightsValid) ||
                    isMaintenanceBlocked
                  }
                  title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                  className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {raritySaving
                    ? tRarityProb("saving")
                    : tRarityProb("save")}
                </button>
              ) : (
                <button
                  onClick={handlePerCardSave}
                  disabled={!perCardHasChanges || perCardSaving || isMaintenanceBlocked}
                  title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                  className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {perCardSaving
                    ? t("batchDropRate.saving")
                    : t("batchDropRate.save")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ヘルプモーダル（親モーダルより上に表示するため z-[60]） */}
      {showHelp && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-gray-800 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">
                {tRarityProb("help.title")}
              </h3>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="text-gray-400 hover:text-white"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="space-y-5 text-sm text-gray-300">
              <div>
                <h4 className="mb-2 font-semibold text-purple-400">
                  {tRarityProb("help.autoModeTitle")}
                </h4>
                <ul className="space-y-1.5 list-disc pl-4">
                  <li>{tRarityProb("help.autoModeDesc1")}</li>
                  <li>{tRarityProb("help.autoModeDesc2")}</li>
                  <li>{tRarityProb("help.autoModeDesc3")}</li>
                </ul>
              </div>

              <div className="rounded-lg bg-gray-700/50 p-3">
                <p className="mb-2 font-medium text-gray-200">
                  {tRarityProb("help.exampleTitle")}
                </p>
                <p className="mb-2 text-xs text-gray-400">
                  {tRarityProb("help.exampleDesc")}
                </p>
                <div className="space-y-0.5 font-mono text-xs text-gray-300">
                  <p>{tRarityProb("help.exampleA")}</p>
                  <p>{tRarityProb("help.exampleB")}</p>
                  <p>{tRarityProb("help.exampleC")}</p>
                </div>
              </div>

              <div>
                <h4 className="mb-2 font-semibold text-gray-200">
                  {tRarityProb("help.perCardModeTitle")}
                </h4>
                <p>{tRarityProb("help.perCardModeDesc")}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
