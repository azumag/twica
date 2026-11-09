"use client";

import { useCallback, useRef, useState } from "react";
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
 * 呼び出し側が isValidSlots で整数であることを確認済みの前提で、空欄だけを落とす。
 */
function toPayload(
  editing: Record<string, EditingThresholds>,
  rarities: string[]
): DuplicateDisplayTiers | null {
  const entries: [string, number[]][] = [];
  for (const rarity of rarities) {
    const parsed = (getOwnThresholds(editing, rarity) ?? [])
      .filter((slot) => slot !== "")
      .map((slot) => Number(slot));
    if (parsed.length > 0) entries.push([rarity, parsed]);
  }
  // 送信値も plain object とし、合法名 __proto__ を JSON から落とさない。
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** 空欄を末尾へ寄せた入力状態にする（"" は「その段階は使わない」）。 */
function compactSlots(slots: EditingThresholds): EditingThresholds {
  const filled = slots.map((slot) => slot.trim()).filter((slot) => slot !== "");
  return [...filled, ...Array.from({ length: MAX_DUPLICATE_TIERS - filled.length }, () => "")];
}

/**
 * 保存の通信中にユーザーが入力を続けても、その入力を保存結果で上書きしない。
 *
 * 保存完了時（成功の確定値・失敗時の元の値）にレアリティの入力欄を丸ごと置き換えると、
 * 通信中に打った別の段階や打ち直した値が消えて「巻き戻る」ように見える。そこで、
 * 確定操作の開始時点（snapshot）から**変わっていない欄だけ**を target に置き換え、
 * 通信中に変わった欄は現在の入力（current）を保つ。保つ入力は次の確定操作で改めて
 * 検証・保存される。
 */
function mergeUnchangedSlots(
  snapshot: EditingThresholds,
  current: EditingThresholds,
  target: EditingThresholds
): EditingThresholds {
  return current.map((slot, index) => (slot === snapshot[index] ? target[index] ?? "" : slot));
}

/** 保存済みのしきい値が1つでもあるか（リセットボタンの有効判定）。 */
function hasAnyThreshold(map: Record<string, EditingThresholds>): boolean {
  return Object.values(map).some((slots) => slots.some((slot) => slot !== ""));
}

/**
 * 重複カードのバッジ設定 (Issue #1782)
 *
 * レアリティごとに「所有枚数がこの枚数に達したら表示段階を1つ上げる」という
 * しきい値を、最大3段階まで設定する。視聴者側のコレクション / カード詳細で
 * 段階に応じたバッジと枠が出る。
 *
 * 保存は既存の POST /api/streamer/settings（CSRF・maintenance・デプロイ窓の
 * フォールバックを共通で持つ唯一の配信者設定経路）へ、マップ全体を送る。
 * AlbumDisplaySettings と同じく、保存できなかった場合は画面上の値を元へ戻し、
 * 「保存したつもり」を作らない。
 *
 * 入力は「確定操作」で保存する（フォーカスが外れたとき / Enter）。キー入力のたびに
 * 検証・保存すると、次の2つの問題が起きるため:
 *  1. 「10」を1文字消すと途中で「1」（最小値 2 未満）になり、不正入力として元の
 *     「10」へ巻き戻されて消せない（2桁以上の値は打ち込みにくくもなる）。
 *  2. キー入力ごとの保存で入力欄が disabled になりフォーカスを失う。
 * 入力中の値は下書き（draft）に留め、確定時に保存済み（saved）と突き合わせる。
 * 保存要求は直列化し、複数欄を続けて確定しても書き込みが競合しないようにする。
 *
 * 全設定は「すべて未設定に戻す」ボタンで null を送って解除できる（機能OFF）。
 *
 * Settings for the duplicate-card badge tiers (Issue #1782). Edits live in a
 * draft and are committed on blur / Enter, so intermediate values such as the
 * "1" while deleting "10" are never validated or rolled back. Saves are
 * serialized through a promise chain.
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

  // saved = サーバへ保存済みの値、draft = 入力中の値。ref は直列化した保存処理が
  // 最新値を読むために持つ（state は再描画用）。
  const [draft, setDraftState] = useState<Record<string, EditingThresholds>>(() =>
    toEditingMap(currentDuplicateDisplayTiers, rarities)
  );
  const [saved, setSavedState] = useState<Record<string, EditingThresholds>>(() =>
    toEditingMap(currentDuplicateDisplayTiers, rarities)
  );
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  // 直列化した保存処理の末尾。確定操作を順に処理する。
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [pendingCount, setPendingCount] = useState(0);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const setDraft = useCallback((next: Record<string, EditingThresholds>) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);
  const setSaved = useCallback((next: Record<string, EditingThresholds>) => {
    savedRef.current = next;
    setSavedState(next);
  }, []);

  /** 保存要求を送る。成功したら true。失敗時のメッセージ表示までここで行う。 */
  const postSettings = useCallback(
    async (
      tiers: DuplicateDisplayTiers | null
    ): Promise<{ ok: true; confirmed: DuplicateDisplayTiers | undefined } | { ok: false }> => {
      try {
        const response = await fetch("/api/streamer/settings", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamerId, duplicateDisplayTiers: tiers }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const maintenanceError = parseMaintenanceError(response, errorData);
          setMessage(maintenanceError?.message || errorData.error || t("errors.saveFailed"));
          setIsError(true);
          return { ok: false };
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
          return { ok: false };
        }

        // サーバ側で確定した値があれば取り込む。応答にキーが無い場合
        // （保存対象が無かった等）は送信値をそのまま確定値とする。
        const confirmed =
          echoed && "duplicateDisplayTiers" in echoed
            ? sanitizeDuplicateDisplayTiers(echoed.duplicateDisplayTiers)
            : undefined;
        return { ok: true, confirmed };
      } catch (error) {
        logger.error("DuplicateDisplayTierSettings save failed:", error);
        setMessage(t("errors.saveFailed"));
        setIsError(true);
        return { ok: false };
      }
    },
    [streamerId, t]
  );

  /** 1レアリティの入力を確定する（保存要求の直列チェーンの中で実行する）。 */
  const commitRarity = useCallback(
    async (rarity: string) => {
      const savedSlots = getOwnThresholds(savedRef.current, rarity) ?? emptySlots();
      const draftSlots = getOwnThresholds(draftRef.current, rarity) ?? emptySlots();
      // 失敗・不正入力で元へ戻すときも、確定操作の開始後に入力された欄は戻さない。
      const revert = () =>
        setDraft({
          ...draftRef.current,
          [rarity]: mergeUnchangedSlots(
            draftSlots,
            getOwnThresholds(draftRef.current, rarity) ?? emptySlots(),
            savedSlots
          ),
        });

      // 空欄は末尾へ寄せる。1・2段階目を空けたまま3段階目だけ入力すると
      // 「配列の穴」ができ、厳密増加の検証で毎回 400 になるため、入力しなかった
      // 下位段階は「存在しない段階」として扱う。
      const nextSlots = compactSlots(draftSlots);

      // 小数など整数でない入力は送らない（黙って落とすと別の値が保存される）。
      const allIntegers = nextSlots
        .filter((slot) => slot !== "")
        .every((slot) => Number.isInteger(Number(slot)));
      const next = { ...savedRef.current, [rarity]: nextSlots };
      const tiersToSend = toPayload(next, rarities);

      // 昇順でない・範囲外のしきい値は送らずに元へ戻す。黙って並べ替えると
      // 「入力と違う段階が保存された」ことになり、配信者の段階設計が崩れるため。
      if (!allIntegers || !validateDuplicateDisplayTiers(tiersToSend).ok) {
        revert();
        setMessage(t("errors.invalid"));
        setIsError(true);
        return;
      }

      // 保存済みと同じなら送らない（フォーカスを通過しただけの確定を無害にする）。
      if (nextSlots.join("|") === savedSlots.join("|")) {
        setDraft({ ...draftRef.current, [rarity]: nextSlots });
        return;
      }

      const result = await postSettings(tiersToSend);
      if (!result.ok) {
        revert();
        return;
      }
      const confirmedMap = toEditingMap(result.confirmed ?? tiersToSend ?? {}, rarities);
      setSaved(confirmedMap);
      // 通信中に入力が続いた欄は確定値で上書きしない（巻き戻り防止）。
      setDraft({
        ...draftRef.current,
        [rarity]: mergeUnchangedSlots(
          draftSlots,
          getOwnThresholds(draftRef.current, rarity) ?? emptySlots(),
          getOwnThresholds(confirmedMap, rarity) ?? emptySlots()
        ),
      });
      setIsError(false);
      setMessage(t("messages.saved"));
    },
    [postSettings, rarities, setDraft, setSaved, t]
  );

  /** すべてのしきい値を解除する（null = 機能OFF）。 */
  const resetAll = useCallback(async () => {
    const result = await postSettings(null);
    if (!result.ok) return;
    const empty = toEditingMap({}, rarities);
    setSaved(empty);
    setDraft(empty);
    setIsError(false);
    setMessage(t("messages.reset"));
  }, [postSettings, rarities, setDraft, setSaved, t]);

  /** 保存処理を直列チェーンへ積む。 */
  const enqueue = useCallback((task: () => Promise<void>) => {
    setPendingCount((count) => count + 1);
    saveChainRef.current = saveChainRef.current
      .then(task)
      .catch((error) => logger.error("DuplicateDisplayTierSettings task failed:", error))
      .finally(() => setPendingCount((count) => count - 1));
  }, []);

  const handleThresholdChange = useCallback(
    (rarity: string, slotIndex: number, rawValue: string) => {
      // disabled 中（maintenance）は、DOM 側で change が発火しても書き込まない。
      if (isMaintenanceBlocked) return;
      const slots = [...(getOwnThresholds(draftRef.current, rarity) ?? emptySlots())];
      slots[slotIndex] = rawValue;
      setDraft({ ...draftRef.current, [rarity]: slots });
    },
    [isMaintenanceBlocked, setDraft]
  );

  const handleCommit = useCallback(
    (rarity: string) => {
      if (isMaintenanceBlocked) return;
      enqueue(() => commitRarity(rarity));
    },
    [isMaintenanceBlocked, enqueue, commitRarity]
  );

  const handleReset = useCallback(() => {
    if (isMaintenanceBlocked) return;
    enqueue(resetAll);
  }, [isMaintenanceBlocked, enqueue, resetAll]);

  const saving = pendingCount > 0;
  // 入力は保存中も受け付ける（保存は直列化済み）。止めるのは maintenance のみ。
  const disabled = isMaintenanceBlocked;

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">{t("title")}</h2>
        <button
          type="button"
          onClick={handleReset}
          disabled={disabled || !hasAnyThreshold(saved)}
          className="rounded-lg border border-gray-600 px-3 py-1 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50"
        >
          {t("resetButton")}
        </button>
      </div>

      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      <div className="space-y-3">
        {rarities.map((rarity) => {
          const slots = getOwnThresholds(draft, rarity) ?? emptySlots();
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
                          handleThresholdChange(rarity, slotIndex, event.target.value)
                        }
                        onBlur={() => handleCommit(rarity)}
                        onKeyDown={(event) => {
                          // Enter は確定操作。blur を経由して同じ経路で保存する。
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
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
