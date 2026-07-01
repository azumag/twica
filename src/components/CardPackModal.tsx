"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  MAX_CARD_PACK_NAMES,
  RARITY_CONTROL_CHAR_REGEX as CONTROL_CHAR_REGEX,
  RARITY_BIDI_OVERRIDE_REGEX as BIDI_OVERRIDE_REGEX,
} from "@/lib/constants";
import { MAX_COLLECTION_NAME_LENGTH } from "@/lib/validation/collection-name";
import { logger } from "@/lib/logger";

// ここでの事前検証は UX 向上のためで、最終的な検証はサーバーが行う
// (POST /api/streamer/settings)。検証規則は constants / collection-name の
// 共通定数を共有する。

interface CardPackModalProps {
  isOpen: boolean;
  onClose: () => void;
  streamerId: string;
  cardPackNames: string[];
  // Issue #269再設計: 新規パック追加のみプランでゲートする(削除は常に許可)。
  isPremium?: boolean;
  onSaved: (next: string[]) => void;
}

/**
 * CardPackModal - 事前登録カードパック名の管理モーダル
 *
 * CustomRarityModal と同じパターン: パック名の追加/削除をこのモーダルで行い、
 * 保存すると streamers.card_pack_names に永続化される。カード作成/チャネポ
 * 設定側は、ここで登録済みのパック名から選ぶだけ(自由入力は廃止)。
 *
 * `!isPremium` のときは追加操作のみ無効化する(削除は常に可能)。サーバーが
 * ゲートで一部の追加を却下した場合はレスポンスの実際の永続化リストで
 * ローカルstateを同期し、その旨を案内する(モーダルは閉じない)。
 */
export default function CardPackModal({
  isOpen,
  onClose,
  streamerId,
  cardPackNames,
  isPremium = false,
  onSaved,
}: CardPackModalProps) {
  const t = useTranslations("cardManager");

  const [list, setList] = useState<string[]>(cardPackNames);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // モーダルを開くたびに、保存済みの最新値から編集を開始する。
  useEffect(() => {
    if (isOpen) {
      setList(cardPackNames);
      setInput("");
      setError(null);
      setNotice(null);
    }
  }, [isOpen, cardPackNames]);

  const hasChanges = useMemo(() => {
    if (list.length !== cardPackNames.length) return true;
    return list.some((v, i) => v !== cardPackNames[i]);
  }, [list, cardPackNames]);

  if (!isOpen) return null;

  const handleClose = () => {
    if (hasChanges && !confirm(t("cardPackModal.confirmClose"))) return;
    setList(cardPackNames);
    setInput("");
    setError(null);
    setNotice(null);
    onClose();
  };

  const handleAdd = () => {
    const key = input.trim();
    if (key.length < 1) {
      setError(t("cardPackModal.errorEmpty"));
      return;
    }
    if (key.length > MAX_COLLECTION_NAME_LENGTH) {
      setError(t("cardPackModal.errorTooLong"));
      return;
    }
    if (CONTROL_CHAR_REGEX.test(key) || BIDI_OVERRIDE_REGEX.test(key)) {
      setError(t("cardPackModal.errorInvalidChars"));
      return;
    }
    if (list.includes(key)) {
      setError(t("cardPackModal.errorDuplicate"));
      return;
    }
    if (list.length >= MAX_CARD_PACK_NAMES) {
      setError(t("cardPackModal.errorMax", { max: MAX_CARD_PACK_NAMES }));
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
    setNotice(null);
    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ streamerId, cardPackNames: list }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("cardPackModal.saveFailed"));
      }

      // Issue #269再設計: サーバーが実際に永続化したリストで同期する
      // (basicプランで一部の新規追加が却下された場合を含む)。
      const persisted = Array.isArray(data.cardPackNames) ? (data.cardPackNames as string[]) : list;

      // 自己レビュー指摘: デプロイ窓で書き込み自体が見送られた場合、
      // persisted は「保存前の値」のまま(実際には何も変わっていない)。
      // 成功扱いでモーダルを閉じると、次回読み込み時に静かに消えたように
      // 見えるため、他の非ゲート成功と同様にここで足止めして案内する。
      if (data.cardPackNamesSkippedDeployWindow) {
        setList(persisted);
        setNotice(t("cardPackModal.deployWindow"));
        return;
      }

      if (data.cardPackNamesPremiumRequired) {
        setList(persisted);
        setNotice(t("cardPackModal.premiumRequired"));
        return;
      }

      onSaved(persisted);
      onClose();
    } catch (err) {
      logger.error("Failed to save card pack names:", err);
      setError(err instanceof Error ? err.message : t("cardPackModal.saveFailed"));
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
              {t("cardPackModal.title")}
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
            {t("cardPackModal.description")}
          </p>
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <div>
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                maxLength={MAX_COLLECTION_NAME_LENGTH}
                disabled={!isPremium}
                placeholder={t("cardPackModal.addPlaceholder")}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
                className="w-full min-w-0 rounded-lg bg-gray-600 px-4 py-2 text-white placeholder:text-gray-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="button"
                onClick={handleAdd}
                disabled={!isPremium}
                className="rounded-lg border border-purple-600 px-4 py-2 text-purple-400 hover:bg-purple-600 hover:text-white transition whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-purple-400"
              >
                {t("cardPackModal.add")}
              </button>
            </div>
            {!isPremium && (
              <p className="mt-2 text-xs text-yellow-300">
                {t("cardPackModal.premiumRequiredHint")}
                <a href="/plans" className="ml-1 text-purple-400 hover:text-purple-300 underline">
                  支援特典について
                </a>
              </p>
            )}
            {error && (
              <p className="mt-2 text-sm text-red-400">{error}</p>
            )}
            {notice && (
              <p className="mt-2 text-sm text-yellow-300">{notice}</p>
            )}

            <div className="mt-4">
              {list.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {t("cardPackModal.empty")}
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
              {t("cardPackModal.deleteNote")}
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
            {saving ? t("cardPackModal.saving") : t("cardPackModal.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
