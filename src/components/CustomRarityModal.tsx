"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  RARITIES,
  MAX_RARITY_KEY_LENGTH,
  MAX_CUSTOM_RARITIES,
  RARITY_CONTROL_CHAR_REGEX as CONTROL_CHAR_REGEX,
  RARITY_BIDI_OVERRIDE_REGEX as BIDI_OVERRIDE_REGEX,
} from "@/lib/constants";
import { logger } from "@/lib/logger";

// ここでの事前検証は UX 向上のためで、最終的な検証はサーバーが行う
// (POST /api/streamer/settings)。検証規則は constants の共通定数を共有する。

const DEFAULT_RARITY_VALUES = new Set<string>(RARITIES.map((r) => r.value));

interface CustomRarityModalProps {
  isOpen: boolean;
  onClose: () => void;
  streamerId: string;
  customRarities: string[];
  onSaved: (next: string[]) => void;
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
  onSaved,
}: CustomRarityModalProps) {
  const t = useTranslations("cardManager");
  const tRarity = useTranslations("rarity");

  const [list, setList] = useState<string[]>(customRarities);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // モーダルを開くたびに、保存済みの最新値から編集を開始する。
  // 閉じている間に親の customRarities が変わってもズレないようにする。
  useEffect(() => {
    if (isOpen) {
      setList(customRarities);
      setInput("");
      setError(null);
    }
  }, [isOpen, customRarities]);

  const hasChanges = useMemo(() => {
    if (list.length !== customRarities.length) return true;
    return list.some((v, i) => v !== customRarities[i]);
  }, [list, customRarities]);

  if (!isOpen) return null;

  const handleClose = () => {
    if (hasChanges && !confirm(t("customRarity.confirmClose"))) return;
    // 次回開いたときに保存済みの値から再開できるよう破棄
    setList(customRarities);
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
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ streamerId, customRarities: list }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("customRarity.saveFailed"));
      }
      onSaved(list);
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
                  if (e.key === "Enter") {
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
                      className="flex items-center justify-between rounded-lg bg-gray-700 px-4 py-2"
                    >
                      <span className="text-white break-all">{value}</span>
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
            disabled={saving || !hasChanges}
            className="rounded-lg bg-purple-600 px-6 py-2 text-white hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? t("customRarity.saving") : t("customRarity.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
