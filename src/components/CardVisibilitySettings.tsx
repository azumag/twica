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
  // #2070 フォローアップ (C4b): 未所持カードの項目別公開の初期値。
  // 旧来の単一「詳細を公開」フラグ (show_unowned_card_details) は API の
  // 互換入力としてのみ残り、新UIはこの3項目を直接読み書きする。
  // Per-item initial values for unowned-card visibility.
  currentShowUnownedName: boolean;
  currentShowUnownedImage: boolean;
  currentShowUnownedDescription: boolean;
}

/** 3項目のキー。表示順・保存キー・翻訳キーの対応を1箇所に集約する。 */
type UnownedItemKey = "name" | "image" | "description";

const UNOWNED_ITEMS: readonly UnownedItemKey[] = ["name", "image", "description"];

/**
 * 項目ごとの翻訳キー。テンプレートリテラルでキーを組み立てると、messages の
 * キー名変更を型・grep で追えなくなるため、静的な対応表にする。
 */
const ITEM_MESSAGE_KEYS = {
  name: {
    label: "form.showName",
    help: "form.showNameHelp",
    enabled: "messages.nameEnabled",
    disabled: "messages.nameDisabled",
  },
  image: {
    label: "form.showImage",
    help: "form.showImageHelp",
    enabled: "messages.imageEnabled",
    disabled: "messages.imageDisabled",
  },
  description: {
    label: "form.showDescription",
    help: "form.showDescriptionHelp",
    enabled: "messages.descriptionEnabled",
    disabled: "messages.descriptionDisabled",
  },
} as const;

type SavePayload = {
  showUnownedCards?: boolean;
  showUnownedCardName?: boolean;
  showUnownedCardImage?: boolean;
  showUnownedCardDescription?: boolean;
};

/**
 * 未所持カード表示設定コンポーネント (Issue #395 / #2070 フォローアップ)
 * Settings UI for the viewer-facing visibility of unowned cards.
 *
 * - 「未所持カードを表示」 (showUnowned): 視聴者ページに未所持カードを並べるか
 * - 「未所持カードの扱い」: 名前・画像・説明を項目別に公開するか
 *
 * 項目別チェックボックスは showUnowned=true のときだけ意味を持つ。
 * マスタースイッチが OFF の間は disabled にし、依存関係を明示する。
 * マスタースイッチを OFF にする操作では3項目も同時に false で保存する
 * （現行の詳細公開フラグのリセットと同じ理由: DBに true が残ると、後で
 * 表示を再ONした瞬間に意図せず公開状態が復活するため）。
 * API 側は show_unowned_cards=false だけでは3項目を書き換えないので、
 * リセットはこのUIの責務である。
 */
export default function CardVisibilitySettings({
  streamerId,
  currentShowUnowned,
  currentShowUnownedName,
  currentShowUnownedImage,
  currentShowUnownedDescription,
}: CardVisibilitySettingsProps) {
  const t = useTranslations("cardVisibilitySettings");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6b: ダッシュボード共有Context経由のmaintenance状態。
  // トグルのたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [showUnowned, setShowUnowned] = useState(currentShowUnowned);
  const [showName, setShowName] = useState(currentShowUnownedName);
  const [showImage, setShowImage] = useState(currentShowUnownedImage);
  const [showDescription, setShowDescription] = useState(currentShowUnownedDescription);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  /**
   * 設定保存。サーバーは指定したフィールドのみ更新するので、変更したものだけ送る。
   * Server updates only the keys we send, so include only the toggled field.
   *
   * #2070 フォローアップ (C4b): 新3列が未デプロイの窓では、API が
   * unownedCardItemSettingsSkippedDeployWindow を返して書き込みを見送る。
   * 200 でも実際には保存されていないため、ここで false（失敗）として扱い、
   * 呼び出し側に楽観反映のロールバックをさせる（サイレント欠損の防止）。
   */
  const saveSettings = useCallback(
    async (payload: SavePayload): Promise<boolean> => {
      setSaving(true);
      try {
        const response = await fetch("/api/streamer/settings", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamerId, ...payload }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          // maintenance mode による503拒否ならサーバーの案内文言をそのまま出す
          // （事前disableをすり抜けた場合＝ポーリング間隔中に切り替わった等の
          // フォールバック表示。#694 Stage 6bの要求「fetch失敗時のエラー表示」）。
          const maintenanceError = parseMaintenanceError(response, data);
          setMessage(maintenanceError?.message || data.error || t("errors.saveFailed"));
          setIsError(true);
          return false;
        }
        if (data.unownedCardItemSettingsSkippedDeployWindow) {
          setMessage(t("errors.deployWindow"));
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
    // 失敗時に3項目の楽観リセットも戻せるよう、変更前の値を保持する。
    const previousItems = { name: showName, image: showImage, description: showDescription };
    setShowUnowned(next);
    // 表示OFFに切り替える際は、項目別公開フラグも同時に false にする。
    // 残しておくと、後で再度ONにした瞬間に意図せず詳細が公開状態になってしまうため。
    // When turning visibility off, reset all item flags in the same request so a
    // later re-enable doesn't unexpectedly reveal them from stale DB state.
    const payload: SavePayload = next
      ? { showUnownedCards: true }
      : {
          showUnownedCards: false,
          showUnownedCardName: false,
          showUnownedCardImage: false,
          showUnownedCardDescription: false,
        };
    const ok = await saveSettings(payload);
    if (ok) {
      setMessage(next ? t("messages.shownEnabled") : t("messages.shownDisabled"));
      if (!next) {
        setShowName(false);
        setShowImage(false);
        setShowDescription(false);
      }
    } else {
      setShowUnowned(!next);
      if (!next) {
        // デプロイ窓 skip 等で保存全体が失敗したときは、項目別の
        // 楽観リセットも元に戻す（UIとDBの見た目を食い違わせない）。
        // なお skip フラグは「新3列だけ保存できなかった」を意味し、
        // show_unowned_cards 自体は保存されている可能性がある。どの項目が
        // 永続化されたかをクライアントから確定できないため、ここでは全体を
        // ロールバックし、次回の読み込み（サーバー初期値）で再同期させる。
        setShowName(previousItems.name);
        setShowImage(previousItems.image);
        setShowDescription(previousItems.description);
      }
    }
  }, [showUnowned, showName, showImage, showDescription, saveSettings, t]);

  /**
   * 項目別チェックボックスの共通ハンドラ。1項目だけ送信し、成功時に表示文言を
   * 更新する。失敗（通信エラー・デプロイ窓 skip）時はその項目だけ元に戻す。
   */
  const handleToggleItem = useCallback(
    async (item: UnownedItemKey) => {
      const current =
        item === "name" ? showName : item === "image" ? showImage : showDescription;
      const next = !current;
      const setter =
        item === "name" ? setShowName : item === "image" ? setShowImage : setShowDescription;

      setter(next);
      const payload: SavePayload = {};
      if (item === "name") payload.showUnownedCardName = next;
      if (item === "image") payload.showUnownedCardImage = next;
      if (item === "description") payload.showUnownedCardDescription = next;

      const ok = await saveSettings(payload);
      if (ok) {
        const keys = ITEM_MESSAGE_KEYS[item];
        setMessage(t(next ? keys.enabled : keys.disabled));
      } else {
        setter(!next);
      }
    },
    [showName, showImage, showDescription, saveSettings, t]
  );

  // 項目別チェックボックスは showUnowned=false の場合は事実上意味を持たないため
  // UI を disable する。The item checkboxes are gated by showUnowned to make the
  // dependency explicit. #694 Stage 6b: maintenance中も書き込み不可のためdisable。
  const itemsDisabled = !showUnowned || saving || isMaintenanceBlocked;
  const showUnownedDisabled = saving || isMaintenanceBlocked;

  const itemState: Record<UnownedItemKey, boolean> = {
    name: showName,
    image: showImage,
    description: showDescription,
  };

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

        {/* 未所持カードの扱い（名前・画像・説明の個別公開） */}
        <fieldset
          className="space-y-3 rounded-lg border border-gray-700 p-4"
          aria-describedby="unowned-items-description-trade-note unowned-items-trade-number-note"
        >
          <legend className="px-1 text-sm font-semibold text-gray-200">
            {t("form.itemsTitle")}
          </legend>
          <p className="text-xs text-gray-500">{t("form.itemsHelp")}</p>

          {UNOWNED_ITEMS.map((item) => {
            const inputId = `show-unowned-${item}-checkbox`;
            const helpId = `${inputId}-help`;
            const keys = ITEM_MESSAGE_KEYS[item];
            return (
              <div key={item}>
                <div className="flex items-center gap-2">
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={itemState[item]}
                    onChange={() => handleToggleItem(item)}
                    disabled={itemsDisabled}
                    aria-label={t(keys.label)}
                    aria-describedby={
                      showUnowned ? helpId : `${helpId} unowned-items-requires`
                    }
                    className="h-4 w-4 rounded border-gray-500 bg-gray-700 text-purple-600 focus:ring-purple-500 disabled:opacity-50"
                  />
                  <label
                    htmlFor={inputId}
                    className={`text-sm ${showUnowned ? "text-gray-300" : "text-gray-500"}`}
                  >
                    {t(keys.label)}
                  </label>
                </div>
                <p id={helpId} className="ml-6 text-xs text-gray-500">
                  {t(keys.help)}
                </p>
              </div>
            );
          })}

          {!showUnowned && (
            <p id="unowned-items-requires" className="text-xs text-gray-500">
              {t("form.requiresShowUnowned")}
            </p>
          )}

          {/* 説明がトレード・オークションに出ないことの明示（仕様の取り違え防止）。 */}
          <p id="unowned-items-description-trade-note" className="text-xs text-gray-400">
            {t("form.descriptionTradeNote")}
          </p>
          {/* 全項目非公開でも #N で取引できること、マスターOFF時は取引不可の明示。 */}
          <p id="unowned-items-trade-number-note" className="text-xs text-gray-400">
            {t("form.tradeNumberNote")}
          </p>
        </fieldset>

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
