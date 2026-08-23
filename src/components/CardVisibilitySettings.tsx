"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

interface CardVisibilitySettingsProps {
  streamerId: string;
  // 視聴者向けに未所持カードを表示するか（オプトイン、初期値 false）
  // Whether unowned cards are shown on the viewer collection page (opt-in)
  currentShowUnowned: boolean;
  // 未所持カードの画像/説明を露出するか（false=プレースホルダーのみ）
  // Whether to reveal unowned card image/description (false = placeholder only)
  currentShowUnownedDetails: boolean;
}

/**
 * 未所持カード表示設定コンポーネント (Issue #395)
 * Settings UI for the viewer-facing visibility of unowned cards.
 *
 * - 「未所持カードを表示」 (showUnowned): 視聴者ページに未所持カードを並べるか
 * - 「未所持カードの詳細を公開」 (showDetails): 表示する場合に画像/説明を出すか
 *
 * showDetails は showUnowned=true のときだけ意味を持つ。
 * showDetails has no effect while showUnowned is false; the UI surfaces this dependency.
 */
export default function CardVisibilitySettings({
  streamerId,
  currentShowUnowned,
  currentShowUnownedDetails,
}: CardVisibilitySettingsProps) {
  const t = useTranslations("cardVisibilitySettings");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6b: ダッシュボード共有Context経由のmaintenance状態。
  // トグルのたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [showUnowned, setShowUnowned] = useState(currentShowUnowned);
  const [showDetails, setShowDetails] = useState(currentShowUnownedDetails);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  /**
   * 設定保存。サーバーは指定したフィールドのみ更新するので、変更したものだけ送る。
   * Server updates only the keys we send, so include only the toggled field.
   */
  const saveSettings = useCallback(
    async (
      payload: { showUnownedCards?: boolean; showUnownedCardDetails?: boolean }
    ): Promise<boolean> => {
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
          // maintenance mode による503拒否ならサーバーの案内文言をそのまま出す
          // （事前disableをすり抜けた場合＝ポーリング間隔中に切り替わった等の
          // フォールバック表示。#694 Stage 6bの要求「fetch失敗時のエラー表示」）。
          const maintenanceError = parseMaintenanceError(response, errorData);
          setMessage(maintenanceError?.message || errorData.error || t("errors.saveFailed"));
          setIsError(true);
          return false;
        }
        setIsError(false);
        return true;
      } catch (error) {
        logger.error("CardVisibilitySettings save failed:", error);
        setMessage(t("errors.saveFailed"));
        setIsError(true);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [streamerId, t]
  );

  const handleToggleShowUnowned = useCallback(async () => {
    const next = !showUnowned;
    setShowUnowned(next);
    // 表示OFFに切り替える際は、詳細公開フラグも同時に false にしておく。
    // 残しておくと、後で再度ONにした瞬間に意図せず詳細が公開状態になってしまうため。
    // When turning visibility off, also reset the details flag so a later re-enable
    // doesn't unexpectedly reveal images/descriptions due to stale DB state.
    const payload = next
      ? { showUnownedCards: true }
      : { showUnownedCards: false, showUnownedCardDetails: false };
    const ok = await saveSettings(payload);
    if (ok) {
      setMessage(next ? t("messages.shownEnabled") : t("messages.shownDisabled"));
      if (!next) {
        setShowDetails(false);
      }
    } else {
      setShowUnowned(!next);
    }
  }, [showUnowned, saveSettings, t]);

  const handleToggleShowDetails = useCallback(async () => {
    const next = !showDetails;
    setShowDetails(next);
    const ok = await saveSettings({ showUnownedCardDetails: next });
    if (ok) {
      setMessage(
        next ? t("messages.detailsEnabled") : t("messages.detailsDisabled")
      );
    } else {
      setShowDetails(!next);
    }
  }, [showDetails, saveSettings, t]);

  // showDetails は showUnowned=false の場合は事実上意味を持たないため UI を disable
  // The details toggle is gated by showUnowned to make the dependency explicit.
  // #694 Stage 6b: maintenance中は両トグルとも書き込み不可のためdisableに含める。
  const detailsDisabled = !showUnowned || saving || isMaintenanceBlocked;
  const showUnownedDisabled = saving || isMaintenanceBlocked;

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">{t("title")}</h2>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${
            showUnowned
              ? "bg-green-500/20 text-green-400"
              : "bg-gray-500/20 text-gray-400"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              showUnowned ? "bg-green-500" : "bg-gray-500"
            }`}
          />
          {showUnowned ? t("status.enabled") : t("status.disabled")}
        </span>
      </div>

      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      <div className="space-y-4">
        {/* 未所持カードを表示 */}
        <div className="flex items-center gap-3">
          <label
            htmlFor="show-unowned-cards-toggle"
            className="relative inline-flex cursor-pointer items-center"
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
          >
            <input
              id="show-unowned-cards-toggle"
              type="checkbox"
              checked={showUnowned}
              onChange={handleToggleShowUnowned}
              disabled={showUnownedDisabled}
              aria-describedby="show-unowned-cards-help"
              className="peer sr-only"
            />
            <div className="h-6 w-11 rounded-full bg-gray-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-disabled:opacity-50" />
          </label>
          <label htmlFor="show-unowned-cards-toggle" className="cursor-pointer text-sm text-gray-300">
            {t("form.showUnowned")}
          </label>
        </div>
        <p id="show-unowned-cards-help" className="-mt-2 ml-14 text-xs text-gray-500">
          {t("form.showUnownedHelp")}
        </p>

        {/* 未所持カードの詳細を公開 */}
        <div className="flex items-center gap-3">
          <label
            htmlFor="show-unowned-details-toggle"
            className="relative inline-flex cursor-pointer items-center"
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
          >
            <input
              id="show-unowned-details-toggle"
              type="checkbox"
              checked={showDetails}
              onChange={handleToggleShowDetails}
              disabled={detailsDisabled}
              aria-describedby={
                showUnowned
                  ? "show-unowned-details-help"
                  : "show-unowned-details-help show-unowned-details-requires"
              }
              className="peer sr-only"
            />
            <div
              className={`h-6 w-11 rounded-full bg-gray-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-disabled:opacity-50 ${
                !showUnowned ? "opacity-50" : ""
              }`}
            />
          </label>
          <label
            htmlFor="show-unowned-details-toggle"
            className={`cursor-pointer text-sm ${
              showUnowned ? "text-gray-300" : "text-gray-500"
            }`}
          >
            {t("form.showDetails")}
          </label>
          {!showUnowned && (
            <span id="show-unowned-details-requires" className="text-xs text-gray-500">
              ({t("form.requiresShowUnowned")})
            </span>
          )}
        </div>
        <p id="show-unowned-details-help" className="-mt-2 ml-14 text-xs text-gray-500">
          {t("form.showDetailsHelp")}
        </p>

        {message && (
          <p className={`text-sm ${isError ? "text-red-400" : "text-green-400"}`}>
            {message}
          </p>
        )}
        {saving && (
          <p className="text-sm text-gray-400">{t("messages.saving")}</p>
        )}
      </div>
    </div>
  );
}
