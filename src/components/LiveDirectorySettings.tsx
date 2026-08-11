"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

interface LiveDirectorySettingsProps {
  streamerId: string;
  // /live ディレクトリへの掲載オプトイン（デフォルト false）
  currentPublishLiveStatus: boolean;
  // /live でのカード統計公開オプトイン（デフォルト false）
  currentPublishStats: boolean;
}

/**
 * 配信中ディレクトリ掲載設定コンポーネント (Issue #632 / #738)
 *
 * - 「配信中を公表」 (publishLiveStatus): /live に掲載するか（オプトイン）
 * - 「統計を公開」 (publishStats): カード種類数・チャネルポイント引換数を公開するか
 *
 * publishStats は publishLiveStatus=true のときだけ意味を持つ（掲載されない限り
 * 統計も公開されない）。CardVisibilitySettings の依存トグル（showDetails は
 * showUnowned 依存）と同じ UX を踏襲する。
 */
export default function LiveDirectorySettings({
  streamerId,
  currentPublishLiveStatus,
  currentPublishStats,
}: LiveDirectorySettingsProps) {
  const t = useTranslations("liveDirectorySettings");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6b: ダッシュボード共有Context経由のmaintenance状態。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [publishLiveStatus, setPublishLiveStatus] = useState(currentPublishLiveStatus);
  const [publishStats, setPublishStats] = useState(currentPublishStats);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  /**
   * 設定保存。サーバーは指定したフィールドのみ更新するので、変更したものだけ送る。
   */
  const saveSettings = useCallback(
    async (
      payload: { publishLiveStatus?: boolean; publishStats?: boolean }
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
          const maintenanceError = parseMaintenanceError(response, errorData);
          setMessage(maintenanceError?.message || errorData.error || t("errors.saveFailed"));
          setIsError(true);
          return false;
        }
        setIsError(false);
        return true;
      } catch (error) {
        logger.error("LiveDirectorySettings save failed:", error);
        setMessage(t("errors.saveFailed"));
        setIsError(true);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [streamerId, t]
  );

  const handleTogglePublishLiveStatus = useCallback(async () => {
    const next = !publishLiveStatus;
    setPublishLiveStatus(next);
    // 掲載OFFに切り替える際は統計公開フラグも同時に false にしておく。
    // 残しておくと、後で再度ONにした瞬間に意図せず統計が公開状態になってしまうため。
    const payload = next
      ? { publishLiveStatus: true }
      : { publishLiveStatus: false, publishStats: false };
    const ok = await saveSettings(payload);
    if (ok) {
      setMessage(next ? t("messages.liveEnabled") : t("messages.liveDisabled"));
      if (!next) {
        setPublishStats(false);
      }
    } else {
      setPublishLiveStatus(!next);
    }
  }, [publishLiveStatus, saveSettings, t]);

  const handleTogglePublishStats = useCallback(async () => {
    const next = !publishStats;
    setPublishStats(next);
    const ok = await saveSettings({ publishStats: next });
    if (ok) {
      setMessage(next ? t("messages.statsEnabled") : t("messages.statsDisabled"));
    } else {
      setPublishStats(!next);
    }
  }, [publishStats, saveSettings, t]);

  // 統計トグルは掲載OFFの場合は事実上意味を持たないため UI を disable
  const statsDisabled = !publishLiveStatus || saving || isMaintenanceBlocked;
  const liveDisabled = saving || isMaintenanceBlocked;

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">{t("title")}</h2>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${
            publishLiveStatus
              ? "bg-green-500/20 text-green-400"
              : "bg-gray-500/20 text-gray-400"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              publishLiveStatus ? "bg-green-500" : "bg-gray-500"
            }`}
          />
          {publishLiveStatus ? t("status.enabled") : t("status.disabled")}
        </span>
      </div>

      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      <div className="space-y-4">
        {/* 配信中を公表 */}
        <div className="flex items-center gap-3">
          <label
            className="relative inline-flex cursor-pointer items-center"
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
          >
            <input
              type="checkbox"
              checked={publishLiveStatus}
              onChange={handleTogglePublishLiveStatus}
              disabled={liveDisabled}
              className="peer sr-only"
            />
            <div className="h-6 w-11 rounded-full bg-gray-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-disabled:opacity-50" />
          </label>
          <span className="text-sm text-gray-300">
            {t("form.publishLiveStatus")}
          </span>
        </div>
        <p className="-mt-2 ml-14 text-xs text-gray-500">
          {t("form.publishLiveStatusHelp")}
        </p>

        {/* 統計を公開 */}
        <div className="flex items-center gap-3">
          <label
            className="relative inline-flex cursor-pointer items-center"
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
          >
            <input
              type="checkbox"
              checked={publishStats}
              onChange={handleTogglePublishStats}
              disabled={statsDisabled}
              className="peer sr-only"
            />
            <div
              className={`h-6 w-11 rounded-full bg-gray-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-disabled:opacity-50 ${
                !publishLiveStatus ? "opacity-50" : ""
              }`}
            />
          </label>
          <span
            className={`text-sm ${
              publishLiveStatus ? "text-gray-300" : "text-gray-500"
            }`}
          >
            {t("form.publishStats")}
          </span>
          {!publishLiveStatus && (
            <span className="text-xs text-gray-500">
              ({t("form.requiresPublishLiveStatus")})
            </span>
          )}
        </div>
        <p className="-mt-2 ml-14 text-xs text-gray-500">
          {t("form.publishStatsHelp")}
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
