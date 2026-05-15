"use client";

// 視聴者向けコレクション表示名 (Issue #230)。
// 注意: 本機能は Issue では `premium` ラベルが付与されているが、現時点では意図的に
// プラン (canUseStreamerFeatures 以外の) ゲートを設けていない。理由は以下:
//   - 視聴者ページ (`StreamerCollection`) のタイトル文言を差し替えるだけの低コスト
//     機能で、ガチャ実行や視聴者付与など課金的価値とは独立している。
//   - 既存の Streamer Settings 画面に到達できる時点で `canUseStreamerFeatures`
//     が true の前提があり、実質的にストリーマー全員が編集可能で問題ない。
// 将来 premium 限定にする場合は `src/lib/plan.ts` のヘルパで分岐を追加し、UI と
// API (route.ts) の両方で同じ判定を行うこと (UI バイパスを許さない)。
//
// Note: although Issue #230 carries the "premium" label, we intentionally do
// not gate this feature behind a paid plan today. The behavior is a trivial
// title swap on the viewer-facing collection page with no monetary value, and
// gating it would only add friction. Revisit (and gate consistently in both
// the UI and `route.ts`) if pricing strategy changes.

import { FormEvent, useState } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";

interface CollectionNameSettingsProps {
  streamerId: string;
  currentCollectionName: string | null;
  defaultCollectionName: string;
}

const MAX_COLLECTION_NAME_LENGTH = 80;

export default function CollectionNameSettings({
  streamerId,
  currentCollectionName,
  defaultCollectionName,
}: CollectionNameSettingsProps) {
  const t = useTranslations("collectionNameSettings");
  const [collectionName, setCollectionName] = useState(currentCollectionName ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const trimmedName = collectionName.trim();
  const tooLong = trimmedName.length > MAX_COLLECTION_NAME_LENGTH;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tooLong) {
      setMessage(t("errors.tooLong", { max: MAX_COLLECTION_NAME_LENGTH }));
      setIsError(true);
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamerId,
          collectionName: trimmedName || null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        setMessage(errorData.error || t("errors.saveFailed"));
        setIsError(true);
        return;
      }

      setMessage(trimmedName ? t("messages.saved") : t("messages.reset"));
      setIsError(false);
    } catch (error) {
      logger.error("CollectionNameSettings save failed:", error);
      setMessage(t("errors.saveFailed"));
      setIsError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <h2 className="mb-3 text-xl font-semibold text-white">{t("title")}</h2>
      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>

      <form className="space-y-3" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="collection-name" className="mb-2 block text-sm font-medium text-gray-300">
            {t("form.label")}
          </label>
          <input
            id="collection-name"
            type="text"
            value={collectionName}
            maxLength={MAX_COLLECTION_NAME_LENGTH + 1}
            onChange={(event) => setCollectionName(event.target.value)}
            placeholder={defaultCollectionName}
            className="w-full rounded-lg bg-gray-700 px-4 py-2 text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className={`text-xs ${tooLong ? "text-red-400" : "text-gray-500"}`}>
            {t("form.counter", {
              count: trimmedName.length,
              max: MAX_COLLECTION_NAME_LENGTH,
            })}
          </p>
          <button
            type="submit"
            disabled={saving || tooLong}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? t("messages.saving") : t("form.save")}
          </button>
        </div>

        {message && (
          <p className={`text-sm ${isError ? "text-red-400" : "text-green-400"}`}>
            {message}
          </p>
        )}
      </form>
    </div>
  );
}
