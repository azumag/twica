"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import { getRarityDisplayInfo } from "@/lib/rarity";
import {
  MAX_DUPLICATE_TIERS,
  MAX_DUPLICATE_TIER_THRESHOLD,
  MIN_DUPLICATE_TIER_THRESHOLD,
  sanitizeDuplicateDisplayTiers,
  validateDuplicateDisplayTiers,
  type DuplicateDisplayTiers,
} from "@/lib/duplicate-display-tiers";

interface DuplicateDisplayTierSettingsProps {
  streamerId: string;
  /** 設定行に出すレアリティ（既定4種 + カスタムレアリティ）。 */
  rarities: string[];
  /** 保存済みのしきい値（レアリティ → 昇順の所有枚数）。 */
  currentDuplicateDisplayTiers: DuplicateDisplayTiers;
}

/** 1レアリティ分の編集状態。"" = その段階は使わない（段階が存在しない）。 */
type EditingThresholds = string[];

const emptySlots = (): EditingThresholds =>
  Array.from({ length: MAX_DUPLICATE_TIERS }, () => "");

/** constructor / toString 等の継承値は、未設定レアリティのしきい値ではない。 */
function getOwnThresholds<T>(map: Record<string, T>, rarity: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, rarity) ? map[rarity] : undefined;
}

/**
 * 保存済みのしきい値を入力欄の状態へ変換する。段階が設定されていない
 * レアリティは全て空欄になる。
 */
function toEditingThresholds(thresholds: number[] | undefined): EditingThresholds {
  const slots = emptySlots();
  if (thresholds) {
    thresholds.forEach((threshold, index) => {
      if (index < MAX_DUPLICATE_TIERS) slots[index] = String(threshold);
    });
  }
  return slots;
}

function toEditingMap(
  tiers: DuplicateDisplayTiers,
  rarities: string[]
): Record<string, EditingThresholds> {
  // fromEntries は __proto__ も own データプロパティにする。通常の {} への
  // 代入で prototype を変えず、初期表示と保存後のエコーで同じ plain map を使う。
  return Object.fromEntries(
    rarities.map((rarity) => [rarity, toEditingThresholds(getOwnThresholds(tiers, rarity))])
  );
}

/**
 * 入力欄の状態を送信用マップへ変換する（全レアリティ空 = null = 機能OFF）。
 * 数値でない欄は落とす（数値入力でも空文字や不正値が届きうるため）。
 */
function toPayload(
  editing: Record<string, EditingThresholds>,
  rarities: string[]
): DuplicateDisplayTiers | null {
  const entries: [string, number[]][] = [];
  for (const rarity of rarities) {
    const parsed = (getOwnThresholds(editing, rarity) ?? [])
      .filter((slot) => slot !== "")
      .map((slot) => Number(slot))
      .filter((value) => Number.isInteger(value));
    if (parsed.length > 0) entries.push([rarity, parsed]);
  }
  // 送信値も plain object とし、合法名 __proto__ を JSON から落とさない。
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * 被りカードの表示段階設定 (Issue #1782)
 *
 * レアリティごとに「所有枚数がこの枚数に達したら表示段階を1つ上げる」という
 * しきい値を、最大3段階まで設定する。視聴者側のコレクション / カード詳細で
 * 段階に応じたバッジと枠が出る。
 *
 * 保存は既存の POST /api/streamer/settings（CSRF・maintenance・デプロイ窓の
 * フォールバックを共通で持つ唯一の配信者設定経路）へ、変更のたびにマップ全体を
 * 送る。AlbumDisplaySettings と同じく、保存できなかった場合は画面上の値を元へ
 * 戻し、「保存したつもり」を作らない。
 *
 * Settings for the duplicate-card display tiers (Issue #1782). Persisted
 * through the shared streamer settings route so CSRF / maintenance /
 * deploy-window behavior stays single, exactly like AlbumDisplaySettings.
 */
export default function DuplicateDisplayTierSettings({
  streamerId,
  rarities,
  currentDuplicateDisplayTiers,
}: DuplicateDisplayTierSettingsProps) {
  const t = useTranslations("duplicateTierSettings");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6b: ダッシュボード共有Context経由のmaintenance状態。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [thresholds, setThresholds] = useState<Record<string, EditingThresholds>>(() =>
    toEditingMap(currentDuplicateDisplayTiers, rarities)
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const saveSettings = useCallback(
    async (payload: { duplicateDisplayTiers: DuplicateDisplayTiers | null }): Promise<boolean> => {
      setSaving(true);
      try {
        const response = await fetch("/api/streamer/settings", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamerId, ...payload }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const maintenanceError = parseMaintenanceError(response, errorData);
          setMessage(maintenanceError?.message || errorData.error || t("errors.saveFailed"));
          setIsError(true);
          return false;
        }
        const data: unknown = await response.json().catch(() => null);
        const echoed =
          data && typeof data === "object"
            ? (data as {
                duplicateDisplayTiers?: unknown;
                duplicateDisplayTiersSkippedDeployWindow?: unknown;
              })
            : null;

        // デプロイ窓（migration 未適用）では route が 200 を返しつつ当該列を
        // UPDATE から剥がす。HTTP 200 を「保存できた」と扱うと、未保存の値を
        // 保存済みとして見せてしまう（サイレント欠損）ため、失敗として返し
        // 呼び出し側に楽観反映を戻させる。
        if (echoed?.duplicateDisplayTiersSkippedDeployWindow === true) {
          setMessage(t("errors.unavailable"));
          setIsError(true);
          return false;
        }

        // サーバ側で確定した値を取り込み、表示と DB を一致させる。
        // 応答にキーが無い場合（保存対象が無かった等）は送信値を保持する。
        if (echoed && "duplicateDisplayTiers" in echoed) {
          const sanitized = sanitizeDuplicateDisplayTiers(echoed.duplicateDisplayTiers);
          setThresholds(toEditingMap(sanitized, rarities));
        }
        setIsError(false);
        setMessage(t("messages.saved"));
        return true;
      } catch (error) {
        logger.error("DuplicateDisplayTierSettings save failed:", error);
        setMessage(t("errors.saveFailed"));
        setIsError(true);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [streamerId, rarities, t]
  );

  const handleThresholdChange = useCallback(
    async (rarity: string, slotIndex: number, rawValue: string) => {
      // disabled 中（maintenance / 保存中）は、DOM 側で change が発火しても
      // 書き込みを送らない。UI の disabled だけに依存しない。
      if (isMaintenanceBlocked || saving) return;

      const previous = thresholds;
      const previousSlots = getOwnThresholds(previous, rarity) ?? emptySlots();

      // 空欄（＝その段階は使わない）を許可するため入力は文字列のまま保持する。
      // 空欄は必ず末尾へ寄せる: 例えば1・2段階目を空けたまま3段階目だけ入力
      // すると「配列の穴」ができ、厳密増加の検証で毎回 400 になる。
      // 入力しなかった下位段階は「存在しない段階」として扱う。
      const edited = [...previousSlots];
      edited[slotIndex] = rawValue.trim();
      const filled = edited.filter((slot) => slot !== "");
      const nextSlots: EditingThresholds = [
        ...filled,
        ...Array.from({ length: MAX_DUPLICATE_TIERS - filled.length }, () => ""),
      ];

      const next: Record<string, EditingThresholds> = { ...previous, [rarity]: nextSlots };
      setThresholds(next);

      const tiersToSend = toPayload(next, rarities);

      // 昇順でない・範囲外のしきい値は送らずに元へ戻す。黙って並べ替えると
      // 「入力と違う段階が保存された」ことになり、配信者の段階設計が崩れるため。
      if (!validateDuplicateDisplayTiers(tiersToSend).ok) {
        setThresholds(previous);
        setMessage(t("errors.invalid"));
        setIsError(true);
        return;
      }

      const ok = await saveSettings({ duplicateDisplayTiers: tiersToSend });
      if (!ok) setThresholds(previous);
    },
    [thresholds, saveSettings, isMaintenanceBlocked, saving, rarities, t]
  );

  const disabled = saving || isMaintenanceBlocked;

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">{t("title")}</h2>
      </div>

      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      <div className="space-y-3">
        {rarities.map((rarity) => {
          const slots = getOwnThresholds(thresholds, rarity) ?? emptySlots();
          const rarityLabel = getRarityDisplayInfo(rarity).label;
          return (
            <div key={rarity} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 break-words text-sm text-gray-200">{rarityLabel}</span>
              <label className="ml-auto flex flex-wrap items-center gap-2 text-xs text-gray-400">
                {slots.map((slot, slotIndex) => {
                  const slotLabel = t("thresholdLabel", { tier: String(slotIndex + 1) });
                  return (
                    <span key={slotIndex} className="flex items-center gap-1">
                      <span>{slotLabel}</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={MIN_DUPLICATE_TIER_THRESHOLD}
                        max={MAX_DUPLICATE_TIER_THRESHOLD}
                        value={slot}
                        placeholder={t("thresholdUnused")}
                        aria-label={`${rarityLabel} ${slotLabel}`}
                        onChange={(event) =>
                          void handleThresholdChange(rarity, slotIndex, event.target.value)
                        }
                        disabled={disabled}
                        className="w-20 rounded-lg border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-200 disabled:opacity-50"
                      />
                    </span>
                  );
                })}
              </label>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-gray-500">{t("thresholdHelp")}</p>

      {message && (
        <p className={`mt-2 text-sm ${isError ? "text-red-400" : "text-green-400"}`}>{message}</p>
      )}
      {saving && <p className="mt-2 text-sm text-gray-400">{t("messages.saving")}</p>}
    </div>
  );
}
