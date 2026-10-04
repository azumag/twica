"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { logger } from "@/lib/logger";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

interface TradeSettingsProps {
  streamerId: string;
  currentTradeEnabled: boolean;
  currentCrossChannelTradeEnabled: boolean;
}

export default function TradeSettings({
  streamerId,
  currentTradeEnabled,
  currentCrossChannelTradeEnabled,
}: TradeSettingsProps) {
  const t = useTranslations("tradeSettings");
  const tMaintenance = useTranslations("maintenance");
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [tradeEnabled, setTradeEnabled] = useState(currentTradeEnabled);
  const [crossChannelTradeEnabled, setCrossChannelTradeEnabled] = useState(
    currentCrossChannelTradeEnabled,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const saveSettings = useCallback(
    async (payload: {
      tradeEnabled?: boolean;
      crossChannelTradeEnabled?: boolean;
    }): Promise<boolean> => {
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
        const data = await response.json().catch(() => ({}));
        if (data.tradeSettingsSkippedDeployWindow) {
          setMessage(t("errors.deployWindow"));
          setIsError(true);
          return false;
        }
        setIsError(false);
        return true;
      } catch (error) {
        logger.error("TradeSettings save failed:", error);
        setMessage(t("errors.saveFailed"));
        setIsError(true);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [streamerId, t],
  );

  const handleTradeToggle = useCallback(async () => {
    const next = !tradeEnabled;
    setTradeEnabled(next);
    const ok = await saveSettings({ tradeEnabled: next });
    if (ok) {
      setMessage(next ? t("messages.enabled") : t("messages.disabled"));
    } else {
      setTradeEnabled(!next);
    }
  }, [tradeEnabled, saveSettings, t]);

  const handleCrossToggle = useCallback(async () => {
    const next = !crossChannelTradeEnabled;
    setCrossChannelTradeEnabled(next);
    const ok = await saveSettings({ crossChannelTradeEnabled: next });
    if (ok) {
      setMessage(next ? t("messages.crossEnabled") : t("messages.crossDisabled"));
    } else {
      setCrossChannelTradeEnabled(!next);
    }
  }, [crossChannelTradeEnabled, saveSettings, t]);

  const parentDisabled = saving || isMaintenanceBlocked;
  const crossDisabled = !tradeEnabled || saving || isMaintenanceBlocked;

  return (
    <div className="rounded-xl bg-gray-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">{t("title")}</h2>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs ${
            tradeEnabled
              ? "bg-green-500/20 text-green-400"
              : "bg-gray-500/20 text-gray-400"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              tradeEnabled ? "bg-green-500" : "bg-gray-500"
            }`}
          />
          {tradeEnabled ? t("status.enabled") : t("status.disabled")}
        </span>
      </div>

      <p className="mb-4 text-sm text-gray-400">{t("description")}</p>
      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      <div className="space-y-4">
        <ToggleRow
          id="trade-enabled-toggle"
          checked={tradeEnabled}
          disabled={parentDisabled}
          label={t("form.tradeEnabled")}
          help={t("form.tradeEnabledHelp")}
          onChange={handleTradeToggle}
          maintenanceTitle={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
        />

        <ToggleRow
          id="cross-channel-trade-enabled-toggle"
          checked={crossChannelTradeEnabled}
          disabled={crossDisabled}
          label={t("form.crossChannelEnabled")}
          help={t("form.crossChannelEnabledHelp")}
          onChange={handleCrossToggle}
          maintenanceTitle={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
          dimmed={!tradeEnabled}
        />

        {!tradeEnabled && (
          <p className="-mt-2 ml-14 text-xs text-gray-500">
            {t("form.requiresTradeEnabled")}
          </p>
        )}

        <p className="rounded-lg bg-yellow-500/10 p-3 text-xs text-yellow-300">
          {t("notice")}
        </p>

        {message && (
          <p className={`text-sm ${isError ? "text-red-400" : "text-green-400"}`}>
            {message}
          </p>
        )}
        {saving && <p className="text-sm text-gray-400">{t("messages.saving")}</p>}
      </div>
    </div>
  );
}

function ToggleRow({
  id,
  checked,
  disabled,
  label,
  help,
  onChange,
  maintenanceTitle,
  dimmed = false,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  help: string;
  onChange: () => void;
  maintenanceTitle?: string;
  dimmed?: boolean;
}) {
  const helpId = `${id}-help`;
  return (
    <div>
      <div className="flex items-center gap-3">
        <label
          htmlFor={id}
          className="relative inline-flex cursor-pointer items-center"
          title={maintenanceTitle}
        >
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={onChange}
            disabled={disabled}
            aria-label={label}
            aria-describedby={helpId}
            className="peer sr-only"
          />
          <div
            className={`h-6 w-11 rounded-full bg-gray-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-purple-600 peer-checked:after:translate-x-full peer-checked:after:border-white peer-disabled:opacity-50 ${
              dimmed ? "opacity-50" : ""
            }`}
          />
        </label>
        <label
          htmlFor={id}
          className={`cursor-pointer text-sm ${dimmed ? "text-gray-500" : "text-gray-300"}`}
        >
          {label}
        </label>
      </div>
      <p id={helpId} className="-mt-0.5 ml-14 text-xs text-gray-500">
        {help}
      </p>
    </div>
  );
}
