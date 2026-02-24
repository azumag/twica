"use client";

import { useTranslations } from "next-intl";

/**
 * View mode type for card display
 * カード表示のビューモードタイプ
 */
export type ViewMode = "thumbnail" | "list";

interface CardViewToggleProps {
  // Current view mode
  // 現在のビューモード
  viewMode: ViewMode;
  // Callback when view mode changes
  // ビューモード変更時のコールバック
  onViewModeChange: (mode: ViewMode) => void;
}

/**
 * Toggle component for switching between thumbnail and list view
 * サムネイルとリスト表示を切り替えるトグルコンポーネント
 */
export default function CardViewToggle({
  viewMode,
  onViewModeChange,
}: CardViewToggleProps) {
  const t = useTranslations("cardView");
  return (
    <div className="flex rounded-lg border border-gray-600 p-1">
      {/* Thumbnail view button */}
      {/* サムネイル表示ボタン */}
      <button
        onClick={() => onViewModeChange("thumbnail")}
        className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${
          viewMode === "thumbnail"
            ? "bg-purple-600 text-white"
            : "text-gray-400 hover:text-white"
        }`}
        aria-pressed={viewMode === "thumbnail"}
        title={t("thumbnail")}
      >
        {/* Grid icon for thumbnail view */}
        {/* サムネイル表示用のグリッドアイコン */}
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
          />
        </svg>
        <span className="hidden sm:inline">{t("thumbnail")}</span>
      </button>

      {/* List view button */}
      {/* リスト表示ボタン */}
      <button
        onClick={() => onViewModeChange("list")}
        className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${
          viewMode === "list"
            ? "bg-purple-600 text-white"
            : "text-gray-400 hover:text-white"
        }`}
        aria-pressed={viewMode === "list"}
        title={t("list")}
      >
        {/* List icon for list view */}
        {/* リスト表示用のリストアイコン */}
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 10h16M4 14h16M4 18h16"
          />
        </svg>
        <span className="hidden sm:inline">{t("list")}</span>
      </button>
    </div>
  );
}
