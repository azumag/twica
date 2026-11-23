"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { logger } from "@/lib/logger";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { getRarityDisplayInfo } from "@/lib/rarity";
import { TRADE_WANTED_RESTRICTION_MAX_ITEMS } from "@/lib/trade-wanted-restriction-limits";
import type { TradeWantedRestrictionSettings as RestrictionData } from "@/lib/trade-wanted-restrictions";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

/**
 * 「交換対象の制限」設定(配信者ごとの許可リスト)。TradeSettings の下に置く。
 * 設計: tasks/plans/trade-wanted-restriction.md v4 §6。
 *
 *   - 配信者ごとに「交換対象リスト」を1つだけ持つ。リストのカードだけが、自分のカードを
 *     出品したとき(通常の出品とオークションの入札)に「求む」へ指定できる。
 *     未設定なら制限なし。許可0件のルールは「誰も指定できない」状態のまま残る(fail-closed)。
 *   - 保存は PUT /api/streamer/trade-wanted-restrictions(リスト全体を丸ごと置換)。
 *     失敗したら画面の状態は保存前のまま(楽観更新しない)。
 *   - 許可カードは同じ配信者のカードだけ(クロスチャネルの相手には指定できない)。
 *     出品カード自身も選べる(リストは出品カードに依存しない)。
 */

type Props = {
  cards: RestrictionData["cards"];
  initialAllowedWantedCardIds: RestrictionData["allowedWantedCardIds"];
};

export default function TradeWantedRestrictionSettings({
  cards,
  initialAllowedWantedCardIds,
}: Props) {
  const t = useTranslations("tradeWantedRestriction");
  const tMaintenance = useTranslations("maintenance");
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";
  const allowedSelectId = useId();

  // null = ルール無し(制限なし)。[] = ルールあり・許可0件(fail-closed)。
  const [allowed, setAllowed] = useState<string[] | null>(initialAllowedWantedCardIds);
  // null = 編集していない。配列 = 編集中の許可カード(空配列は「まだ1枚も選んでいない」)。
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);

  const cardById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const label = useCallback(
    (cardId: string) => {
      const card = cardById.get(cardId);
      if (!card) return t("deletedCard");
      return t("cardLabel", { name: card.name, rarity: getRarityDisplayInfo(card.rarity).label });
    },
    [cardById, t],
  );

  const persist = useCallback(
    async (next: string[]): Promise<boolean> => {
      setSaving(true);
      try {
        const response = await fetch("/api/streamer/trade-wanted-restrictions", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowedWantedCardIds: next }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const maintenanceError = parseMaintenanceError(response, errorData);
          setMessage(
            maintenanceError?.message
              || (response.status === 503 ? t("errors.unavailable") : null)
              || t("errors.saveFailed"),
          );
          setIsError(true);
          return false;
        }
        setIsError(false);
        setAllowed(next.length === 0 ? null : next);
        return true;
      } catch (error) {
        logger.error("TradeWantedRestrictionSettings save failed:", error);
        setMessage(t("errors.saveFailed"));
        setIsError(true);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [t],
  );

  const handleSave = useCallback(async () => {
    if (!draft || draft.length === 0) return;
    if (await persist(draft)) {
      setMessage(t("messages.saved"));
      setDraft(null);
    }
  }, [draft, persist, t]);

  const handleRemove = useCallback(async () => {
    if (await persist([])) {
      setMessage(t("messages.removed"));
      setDraft(null);
    }
  }, [persist, t]);

  const disabled = saving || isMaintenanceBlocked;
  // 許可カードに追加できるのは、有効で、まだ追加していない自分のカード。
  // 1リストあたりの上限がある(API も同じ値で検証する)。上限に達したら追加を止める。
  const atItemLimit = (draft?.length ?? 0) >= TRADE_WANTED_RESTRICTION_MAX_ITEMS;
  const allowedChoices = draft && !atItemLimit
    ? cards.filter((card) => card.isActive && !draft.includes(card.id))
    : [];
  const unchanged = draft !== null && allowed !== null && sameSet(draft, allowed);

  return (
    <div className="mt-6 border-t border-gray-700 pt-6" data-testid="trade-wanted-restriction-settings">
      <h3 className="text-lg font-semibold text-white">{t("title")}</h3>
      <p className="mt-1 text-sm text-gray-400">{t("description")}</p>
      <p className="mt-1 text-xs text-gray-500">{t("scopeNote")}</p>
      {isMaintenanceBlocked && (
        <p className="mt-2 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      {allowed === null ? (
        <p className="mt-4 text-sm text-gray-500">{t("empty")}</p>
      ) : (
        <div className="mt-4 rounded-lg bg-gray-700/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-white">{t("listLabel")}</p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setDraft([...allowed]);
                  setMessage("");
                }}
                className="rounded-md bg-gray-600 px-3 py-1 text-xs text-white hover:bg-gray-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
              >
                {t("edit")}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void handleRemove()}
                className="rounded-md bg-gray-600 px-3 py-1 text-xs text-white hover:bg-gray-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
              >
                {t("remove")}
              </button>
            </div>
          </div>
          {allowed.length === 0 ? (
            <p className="mt-2 text-xs text-yellow-300">{t("emptyRuleWarning")}</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("allowedLabel")}>
              {allowed.map((cardId) => (
                <AllowedChip
                  key={cardId}
                  label={label(cardId)}
                  inactive={cardById.get(cardId)?.isActive === false}
                  inactiveLabel={t("inactiveBadge")}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {draft !== null ? (
        <div className="mt-4 space-y-3 rounded-lg border border-gray-600 p-3">
          <div>
            <label htmlFor={allowedSelectId} className="mb-1 block text-sm text-gray-300">
              {t("allowedAddLabel")}
            </label>
            <select
              id={allowedSelectId}
              value=""
              disabled={disabled || allowedChoices.length === 0 || atItemLimit}
              onChange={(event) => {
                const cardId = event.target.value;
                if (cardId && draft.length < TRADE_WANTED_RESTRICTION_MAX_ITEMS) {
                  setDraft([...draft, cardId]);
                }
              }}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              <option value="">{t("allowedPlaceholder")}</option>
              {allowedChoices.map((card) => (
                <option key={card.id} value={card.id}>
                  {label(card.id)}
                </option>
              ))}
            </select>
            {atItemLimit && (
              <p className="mt-2 text-xs text-yellow-300">
                {t("allowedLimitReached", { max: TRADE_WANTED_RESTRICTION_MAX_ITEMS })}
              </p>
            )}
            {draft.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("allowedLabel")}>
                {draft.map((cardId) => (
                  <AllowedChip
                    key={cardId}
                    label={label(cardId)}
                    inactive={cardById.get(cardId)?.isActive === false}
                    inactiveLabel={t("inactiveBadge")}
                    removeLabel={t("removeAllowed", { card: label(cardId) })}
                    onRemove={() => setDraft(draft.filter((id) => id !== cardId))}
                  />
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-gray-500">{t("allowedEmptyHint")}</p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={disabled || draft.length === 0 || unchanged}
              onClick={() => void handleSave()}
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              {saving ? t("saving") : t("save")}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setMessage("");
              }}
              className="rounded-lg bg-gray-600 px-4 py-2 text-sm text-white hover:bg-gray-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : (
        allowed === null && (
          <button
            type="button"
            disabled={disabled || !cards.some((card) => card.isActive)}
            onClick={() => {
              setDraft([]);
              setMessage("");
            }}
            className="mt-4 rounded-lg bg-gray-600 px-4 py-2 text-sm text-white hover:bg-gray-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
          >
            {t("add")}
          </button>
        )
      )}

      {message && (
        <p role="status" className={`mt-3 text-sm ${isError ? "text-red-400" : "text-green-400"}`}>
          {message}
        </p>
      )}
    </div>
  );
}

/** 許可カードのチップ。編集時は × で外せる。 */
function AllowedChip({
  label,
  inactive,
  inactiveLabel,
  removeLabel,
  onRemove,
}: {
  label: string;
  inactive: boolean;
  inactiveLabel: string;
  removeLabel?: string;
  onRemove?: () => void;
}) {
  return (
    <li className="flex items-center gap-1 rounded-full bg-gray-600 px-2 py-0.5 text-xs text-gray-100">
      {label}
      {inactive && <span className="text-yellow-300">{inactiveLabel}</span>}
      {onRemove && removeLabel && (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className="rounded-full px-1 text-gray-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        >
          ×
        </button>
      )}
    </li>
  );
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}
