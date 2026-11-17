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
  // Issue #2070: トレード限定の未所持カード名公開トグルは、コレクション公開設定の
  // 現在値に依存して操作可否が変わる。サーバー側の初期値をそのまま受け取り、
  // 依存が満たされない間は disabled + 理由表示にする（値は書き換えない）。
  currentShowUnownedCards: boolean;
  currentShowUnownedCardDetails: boolean;
  currentTradeUnownedCardNamesVisible: boolean;
}

export default function TradeSettings({
  streamerId,
  currentTradeEnabled,
  currentCrossChannelTradeEnabled,
  currentShowUnownedCards,
  currentShowUnownedCardDetails,
  currentTradeUnownedCardNamesVisible,
}: TradeSettingsProps) {
  const t = useTranslations("tradeSettings");
  const tMaintenance = useTranslations("maintenance");
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [tradeEnabled, setTradeEnabled] = useState(currentTradeEnabled);
  const [crossChannelTradeEnabled, setCrossChannelTradeEnabled] = useState(
    currentCrossChannelTradeEnabled,
  );
  const [tradeUnownedCardNamesVisible, setTradeUnownedCardNamesVisible] = useState(
    currentTradeUnownedCardNamesVisible,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const saveSettings = useCallback(
    async (payload: {
      tradeEnabled?: boolean;
      crossChannelTradeEnabled?: boolean;
      tradeUnownedCardNamesVisible?: boolean;
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

  const handleUnownedCardNamesToggle = useCallback(async () => {
    const next = !tradeUnownedCardNamesVisible;
    setTradeUnownedCardNamesVisible(next);
    const ok = await saveSettings({ tradeUnownedCardNamesVisible: next });
    if (ok) {
      setMessage(
        next
          ? t("messages.unownedCardNamesEnabled")
          : t("messages.unownedCardNamesDisabled"),
      );
    } else {
      // 保存失敗・デプロイ窓 skip のどちらでも、楽観反映を必ず元へ戻す。
      setTradeUnownedCardNamesVisible(!next);
    }
  }, [tradeUnownedCardNamesVisible, saveSettings, t]);

  const parentDisabled = saving || isMaintenanceBlocked;
  const crossDisabled = !tradeEnabled || saving || isMaintenanceBlocked;
  // Issue #2070: この設定は「未所持カードを表示する」がONで、かつ詳細公開がOFFの
  // ときだけ意味を持つ（詳細公開がONなら名前はすでに見えている）。依存を満たさない
  // 間は操作させず、理由を表示する。保存済みの値を勝手に false へ書き換えない。
  const unownedCardNamesDependencyReason = !currentShowUnownedCards
    ? t("form.unownedCardNamesVisibleRequiresShowUnowned")
    : currentShowUnownedCardDetails
      ? t("form.unownedCardNamesVisibleRequiresDetailsOff")
      : null;
  const unownedCardNamesDisabled =
    saving || isMaintenanceBlocked || unownedCardNamesDependencyReason !== null;

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
      {/* 未所持カードを「欲しいカード」にしたり出品を見たりできるかは、トレード設定ではなく
          CardVisibilitySettings(show_unowned_cards + show_unowned_card_details)で決まる。
          配信者が「トレードをONにしたのに視聴者が未所持カードを選べない」と混乱しないよう、
          依存関係を静的に明示する。両者は dashboard/account の「配信者向け: コレクションの
          公開とトレード」セクション内に CardVisibilitySettings → TradeSettings の順で
          並ぶので、同じ画面のすぐ上にある。リンクは置かない。
          注意: 文案が参照する見出しは cardVisibilitySettings.title（preview では
          「コレクション公開設定」 / "Collection visibility"）で、main の
          「未所持カードの表示設定」とは別値。base を変えたときは必ず実値を取り直す。 */}
      <p className="mb-4 text-xs text-gray-500">{t("visibilityNotice")}</p>
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

        {/* Issue #2070: トレードの掲示板・入札・応諾に限り、未所持カードの名前と
            レアリティだけを公開する。画像・説明とコレクション画面の表示は変えない。
            依存が満たされない間は保存済みの値を保持したまま操作だけを止める。 */}
        <ToggleRow
          id="trade-unowned-card-names-visible-toggle"
          checked={tradeUnownedCardNamesVisible}
          disabled={unownedCardNamesDisabled}
          label={t("form.unownedCardNamesVisible")}
          help={t("form.unownedCardNamesVisibleHelp")}
          onChange={handleUnownedCardNamesToggle}
          maintenanceTitle={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
          dimmed={unownedCardNamesDependencyReason !== null}
        />
        {unownedCardNamesDependencyReason && (
          <p className="-mt-2 ml-14 text-xs text-gray-500">
            {unownedCardNamesDependencyReason}
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
