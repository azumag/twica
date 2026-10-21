"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  RARITIES,
  MAX_RARITY_KEY_LENGTH,
  MAX_CUSTOM_RARITIES,
  RARITY_CONTROL_CHAR_REGEX as CONTROL_CHAR_REGEX,
  RARITY_BIDI_OVERRIDE_REGEX as BIDI_OVERRIDE_REGEX,
} from "@/lib/constants";
import { logger } from "@/lib/logger";
import { isEnterKeySubmit } from "@/lib/keyboard-utils";
import type { RarityStyle } from "@/lib/rarity-styles";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

// ここでの事前検証は UX 向上のためで、最終的な検証はサーバーが行う
// (POST /api/streamer/settings)。検証規則は constants の共通定数を共有する。

const DEFAULT_RARITY_VALUES = new Set<string>(RARITIES.map((r) => r.value));

/**
 * Issue #1783: スタイルマップをキー順に依存せず比較するための署名。
 * 指定キーのうち実体のあるスタイルだけを、キー名とプロパティ名で整列して直列化する。
 */
function styleSignature(styles: Record<string, RarityStyle>, keys: string[]): string {
  return JSON.stringify(
    keys
      .filter((key) => styles[key] && Object.keys(styles[key]).length > 0)
      .slice()
      .sort()
      .map((key) => [
        key,
        Object.entries(styles[key]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ])
  );
}

interface CustomRarityModalProps {
  isOpen: boolean;
  onClose: () => void;
  streamerId: string;
  customRarities: string[];
  rarityStyles?: Record<string, RarityStyle>;
  onSaved: (next: string[]) => void;
  onSavedStyles?: (next: Record<string, RarityStyle>) => void;
}

/**
 * CustomRarityModal - カスタムレアリティ名の管理モーダル
 *
 * デフォルトレアリティ (RARITIES) は常に選択可能なため読み取り専用で表示し、
 * 削除できない。カスタムレアリティ名のみ追加/削除でき、保存すると
 * streamers.custom_rarities に永続化される。
 *
 * このモーダルはレアリティ「名」のみを扱い、ドロップ率設定 (rarity_weights)
 * とは完全に独立している。そのため保存してもカードの排出確率は再計算されない。
 */
export default function CustomRarityModal({
  isOpen,
  onClose,
  streamerId,
  customRarities,
  rarityStyles,
  onSaved,
  onSavedStyles,
}: CustomRarityModalProps) {
  const t = useTranslations("cardManager");
  const tRarity = useTranslations("rarity");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6c: ダッシュボード共有Context経由のmaintenance状態。
  // 保存のたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [list, setList] = useState<string[]>(customRarities);
  const [styles, setStyles] = useState<Record<string, RarityStyle>>(rarityStyles ?? {});
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Issue #1783: デプロイ窓の部分保存（名前だけ保存されスタイルは未保存）で親へ通知した
  // payload。親がその値を採用した1回だけ、未保存の色の下書きを維持するために使う
  // （#1822 の同名実装と同じ扱い。重複実装を増やさないため挙動を合わせている）。
  const partialSaveSync = useRef<{
    customRarities: string[];
    rarityStyles: Record<string, RarityStyle>;
  } | null>(null);
  const previousIsOpen = useRef(false);

  // モーダルを開くたびに、保存済みの最新値から編集を開始する。
  // 閉じている間に親の customRarities が変わってもズレないようにする。
  useEffect(() => {
    const wasOpen = previousIsOpen.current;
    previousIsOpen.current = isOpen;
    if (!isOpen) {
      partialSaveSync.current = null;
      return;
    }
    // 部分保存で通知した payload を親が採用する1回だけ、未保存の色を維持する。
    // 閉じた後に応答が来ても、次回 open は必ず保存済みの値から初期化する。
    const partialSave = partialSaveSync.current;
    partialSaveSync.current = null;
    if (
      wasOpen &&
      partialSave &&
      partialSave.customRarities === customRarities &&
      partialSave.rarityStyles === rarityStyles
    ) {
      return;
    }
    setList(customRarities);
    setStyles(rarityStyles ?? {});
    setInput("");
    setError(null);
  }, [isOpen, customRarities, rarityStyles]);

  // Issue #1783: スタイルは「リストに残っているレアリティ」の分だけを保存対象にする。
  // レアリティを削除したときにスタイルが残ると、サーバー側の allowedKeys 検証で
  // 400 になり保存できなくなるため、ここで落とす。
  const stylesForList = useMemo(() => {
    const next: Record<string, RarityStyle> = {};
    for (const key of list) {
      const style = styles[key];
      if (style && Object.keys(style).length > 0) next[key] = style;
    }
    return next;
  }, [list, styles]);

  const hasChanges = useMemo(() => {
    if (list.length !== customRarities.length) return true;
    if (list.some((v, i) => v !== customRarities[i])) return true;
    // Issue #1783: 色などのスタイルだけを変えた場合も保存対象にする
    // （名前が変わっていないと保存ボタンが押せない、という取りこぼしを防ぐ）。
    return styleSignature(stylesForList, list) !== styleSignature(rarityStyles ?? {}, list);
  }, [list, customRarities, stylesForList, rarityStyles]);

  if (!isOpen) return null;

  const handleClose = () => {
    if (hasChanges && !confirm(t("customRarity.confirmClose"))) return;
    // 次回開いたときに保存済みの値から再開できるよう破棄
    partialSaveSync.current = null;
    setList(customRarities);
    // Issue #1783: スタイルも保存済みの値へ戻す（未保存の色変更を持ち越さない）。
    setStyles(rarityStyles ?? {});
    setInput("");
    setError(null);
    onClose();
  };

  const handleAdd = () => {
    const key = input.trim().normalize("NFC");
    if (key.length < 1) {
      setError(t("customRarity.errorEmpty"));
      return;
    }
    if (key.length > MAX_RARITY_KEY_LENGTH) {
      setError(t("customRarity.errorTooLong"));
      return;
    }
    if (CONTROL_CHAR_REGEX.test(key) || BIDI_OVERRIDE_REGEX.test(key)) {
      setError(t("customRarity.errorInvalidChars"));
      return;
    }
    if (DEFAULT_RARITY_VALUES.has(key)) {
      setError(t("customRarity.errorDefault"));
      return;
    }
    if (list.includes(key)) {
      setError(t("customRarity.errorDuplicate"));
      return;
    }
    if (list.length >= MAX_CUSTOM_RARITIES) {
      setError(t("customRarity.errorMax", { max: MAX_CUSTOM_RARITIES }));
      return;
    }
    setList([...list, key]);
    setInput("");
    setError(null);
  };

  const handleRemove = (value: string) => {
    setList(list.filter((v) => v !== value));
    // Issue #1783: レアリティを外したらスタイルも一緒に落とす。残すとサーバー側の
    // allowedKeys 検証で 400 になり、他の編集ごと保存できなくなる。
    setStyles((prev) => {
      if (!(value in prev)) return prev;
      const next = { ...prev };
      delete next[value];
      return next;
    });
  };

  const handleSave = async () => {
    // #694 Stage 6c: フッターのSaveボタン自体はdisableしているが、
    // CardManager.handleSubmitと同じ方針で送信経路の先頭でも二重にガードする。
    if (isMaintenanceBlocked) {
      setError(tMaintenance("writeDisabled"));
      return;
    }
    setSaving(true);
    setError(null);
    partialSaveSync.current = null;
    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ streamerId, customRarities: list, rarityStyles: stylesForList }),
      });
      const data = await response.json();
      if (!response.ok) {
        // maintenance mode による503拒否ならサーバーの案内文言を優先する。
        const maintenanceError = parseMaintenanceError(response, data);
        throw new Error(maintenanceError?.message || data.error || t("customRarity.saveFailed"));
      }
      // Issue #1783: デプロイ窓で rarity_styles 列がまだ無い環境では、サーバーは他の設定
      // だけを保存して 200 + rarityStylesSkippedDeployWindow を返す。ここで成功扱いにして
      // 閉じると「保存できたように見えて色が失われる」ため、名前の保存だけを反映し、
      // スタイルは保存済みの値を維持して、未保存の下書きと警告を残す（#1822 と同じ扱い）。
      if (data.rarityStylesSkippedDeployWindow === true) {
        const persisted = { customRarities: list, rarityStyles: rarityStyles ?? {} };
        partialSaveSync.current = persisted;
        onSaved(persisted.customRarities);
        onSavedStyles?.(persisted.rarityStyles);
        setError(t("customRarity.stylesNotSaved"));
        return;
      }
      onSaved(list);
      onSavedStyles?.(stylesForList);
      onClose();
    } catch (err) {
      logger.error("Failed to save custom rarities:", err);
      setError(err instanceof Error ? err.message : t("customRarity.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={handleClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">
              {t("customRarity.title")}
            </h3>
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
          <p className="mt-2 text-sm text-gray-400">
            {t("customRarity.description")}
          </p>
          {isMaintenanceBlocked && (
            <p className="mt-2 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
          )}
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* デフォルト（読み取り専用・削除不可） */}
          <div>
            <h4 className="mb-2 text-sm font-medium text-gray-300">
              {t("customRarity.defaultSection")}
            </h4>
            <div className="flex flex-wrap gap-2">
              {RARITIES.map((r) => (
                <span
                  key={r.value}
                  className={`rounded-full px-3 py-1 text-sm text-white ${r.color}`}
                >
                  {tRarity(r.value)}
                </span>
              ))}
            </div>
          </div>

          {/* カスタム */}
          <div>
            <h4 className="mb-2 text-sm font-medium text-gray-300">
              {t("customRarity.customSection")}
            </h4>
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                maxLength={MAX_RARITY_KEY_LENGTH}
                placeholder={t("customRarity.addPlaceholder")}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // CardPackModal (#613) と同種のIME誤送信バグの再発防止として、
                  // 同じガードをここにも適用する。
                  if (isEnterKeySubmit(e)) {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
                className="w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white placeholder:text-gray-400"
              />
              <button
                type="button"
                onClick={handleAdd}
                className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition whitespace-nowrap"
              >
                {t("customRarity.add")}
              </button>
            </div>
            {error && (
              <p className="mt-2 text-sm text-red-400">{error}</p>
            )}

            <div className="mt-4">
              {list.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {t("customRarity.empty")}
                </p>
              ) : (
                <ul className="space-y-2">
                  {list.map((value) => (
                    <li
                      key={value}
                      className="flex items-center justify-between gap-2 rounded-lg bg-gray-700 px-4 py-2"
                    >
                      <span className="text-white break-all">{value}</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={styles[value]?.color?.startsWith("#") ? styles[value]!.color! : "#808080"}
                          onChange={(e) =>
                            setStyles((prev) => ({
                              ...prev,
                              [value]: { ...(prev[value] ?? {}), color: e.target.value },
                            }))
                          }
                          className="h-8 w-8 cursor-pointer rounded border border-gray-600 bg-transparent"
                          aria-label={t("customRarity.colorLabel", { rarity: value })}
                        />
                        {/* Issue #1783: 既定表示（gray）へ戻す手段を用意する。
                            未設定のスタイルは送らないので、キーごと落とす。 */}
                        {styles[value]?.color !== undefined && (
                          <button
                            type="button"
                            onClick={() =>
                              setStyles((prev) => {
                                const next = { ...prev };
                                const current = { ...(next[value] ?? {}) };
                                delete current.color;
                                if (Object.keys(current).length === 0) {
                                  delete next[value];
                                } else {
                                  next[value] = current;
                                }
                                return next;
                              })
                            }
                            className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:border-gray-400 hover:text-white transition"
                          >
                            {t("customRarity.clearColor")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemove(value)}
                          className="ml-2 text-gray-400 hover:text-red-400"
                          aria-label={`Remove ${value}`}
                        >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-5 w-5"
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
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="mt-3 text-xs text-gray-500">
              {t("customRarity.deleteNote")}
            </p>
          </div>
        </div>

        {/* フッター */}
        <div className="p-6 border-t border-gray-700 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !hasChanges || isMaintenanceBlocked}
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
            className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? t("customRarity.saving") : t("customRarity.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
