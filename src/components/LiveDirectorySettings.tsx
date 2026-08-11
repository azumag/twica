"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

interface LiveDirectorySettingsProps {
  streamerId: string;
  // /live ディレクトリへの掲載オプトイン（デフォルト false）
  currentPublishLiveStatus: boolean;
  // DB上の旧名はpublish_statsだが、現在はランキングでのチャネル表示可否を表す。
  currentPublishStats: boolean;
}

/**
 * 配信中ディレクトリ掲載設定コンポーネント (Issue #632 / #738)
 *
 * - 「配信中を公表」 (publishLiveStatus): /live に掲載するか（オプトイン）
 * - 「ランキングにチャネルを表示」 (publishStats): ランキングで配信者を識別可能にするか
 *
 * ランキングの集計値自体は全配信者を対象とし、publishStats=false の行はDB境界で
 * 識別情報を除去して「匿名チャネル」として表示する。配信掲載とランキング上の
 * チャネル表示は別の同意なので、2つのトグルは互いに依存させない。
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
        // #738: デプロイ窓（migration 未適用）でサーバーが書き込みを見送った場合、
        // 200 のまま skip フラグが返る。成功扱いにすると楽観反映による
        // サイレント欠損になるため、GachaSoundSettings と同じパターンで
        // エラー扱いにしてユーザーへ知らせる。
        const data = await response.json().catch(() => ({}));
        if (data.liveDirectorySettingsSkippedDeployWindow === true) {
          setMessage(t("errors.deployWindow"));
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
    // 配信一覧とランキングのチャネル表示は独立した同意。掲載OFFで後者まで
    // 書き換えると、ユーザーが明示的に選んだランキング設定を失うため触らない。
    const ok = await saveSettings({ publishLiveStatus: next });
    if (ok) {
      setMessage(next ? t("messages.liveEnabled") : t("messages.liveDisabled"));
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

  const statsDisabled = saving || isMaintenanceBlocked;
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

      <p className="mb-4 text-sm text-gray-400">
        {t.rich("description", {
          link: (chunks) => (
            <Link
              href="/live"
              className="text-purple-300 underline decoration-purple-400/60 underline-offset-2 transition hover:text-purple-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              {chunks}
            </Link>
          ),
        })}
      </p>

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      <div className="space-y-4">
        {/* 可視テキストをinputへ関連付け、スイッチの目的を支援技術にも伝える。 */}
        <div className="flex items-center">
          <label
            htmlFor="publish-live-status"
            className="inline-flex cursor-pointer items-center gap-3"
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
          >
            <input
              id="publish-live-status"
              type="checkbox"
              checked={publishLiveStatus}
              onChange={handleTogglePublishLiveStatus}
              disabled={liveDisabled}
              aria-describedby="publish-live-status-help"
              className="peer sr-only"
            />
            <span className="relative h-6 w-11 shrink-0 rounded-full bg-gray-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-disabled:opacity-50" />
            <span className="text-sm text-gray-300">
              {t("form.publishLiveStatus")}
            </span>
          </label>
        </div>
        <p id="publish-live-status-help" className="-mt-2 ml-14 text-xs text-gray-500">
          {t("form.publishLiveStatusHelp")}
        </p>

        <div className="flex items-center">
          <label
            htmlFor="publish-ranking-channel"
            className="inline-flex cursor-pointer items-center gap-3"
            title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
          >
            <input
              id="publish-ranking-channel"
              type="checkbox"
              checked={publishStats}
              onChange={handleTogglePublishStats}
              disabled={statsDisabled}
              aria-describedby="publish-ranking-channel-help"
              className="peer sr-only"
            />
            <span className="relative h-6 w-11 shrink-0 rounded-full bg-gray-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-disabled:opacity-50" />
            <span className="text-sm text-gray-300">
              {t("form.publishStats")}
            </span>
          </label>
        </div>
        <p id="publish-ranking-channel-help" className="-mt-2 ml-14 text-xs text-gray-500">
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
