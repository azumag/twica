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
 * 「交換対象の制限」設定(出品カードごとのホワイトリスト)。TradeSettings の下に置く。
 * 設計: tasks/plans/trade-wanted-restriction.md §6。
 *
 *   - 出品カード A を選び、A の出品で「求める」に指定できるカードを1枚ずつ追加する。
 *     追加したカード(許可カード)だけが交換対象になる。ルールが無いカードは制限なし。
 *   - 保存は PUT /api/streamer/trade-wanted-restrictions(出品カード1枚ぶんを丸ごと置換)。
 *     失敗したら画面の状態は保存前のまま(楽観更新しない)。
 *   - 許可カードは同じ配信者のカードだけ(クロスチャネルの相手には指定できない)。
 *   - 許可カードがすべて削除されて0件になったルールは「誰も指定できない」状態のまま残る
 *     (制限が外れない)。ここでは警告を出して、編集か解除を促す。
 */

type Props = {
  cards: RestrictionData["cards"];
  initialRules: RestrictionData["rules"];
};

type Draft = { offeredCardId: string | null; allowed: string[]; isNew: boolean };

export default function TradeWantedRestrictionSettings({ cards, initialRules }: Props) {
  const t = useTranslations("tradeWantedRestriction");
  const tMaintenance = useTranslations("maintenance");
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";
  const offeredSelectId = useId();
  const allowedSelectId = useId();

  const [rules, setRules] = useState<Record<string, string[]>>(initialRules);
  const [draft, setDraft] = useState<Draft | null>(null);
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
  // 一覧の並びはサーバーが返したカード順(レアリティ → 名前)に揃える。
  const ruleIds = useMemo(
    () => cards.map((card) => card.id).filter((cardId) => cardId in rules),
    [cards, rules],
  );

  const persist = useCallback(
    async (offeredCardId: string, allowed: string[]): Promise<boolean> => {
      setSaving(true);
      try {
        const response = await fetch("/api/streamer/trade-wanted-restrictions", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offeredCardId, allowedWantedCardIds: allowed }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const maintenanceError = parseMaintenanceError(response, errorData);
          setMessage(
            maintenanceError?.message
              || (response.status === 503 ? t("errors.unavailable") : null)
              || (errorData.code === "TOO_MANY_RULES" ? t("errors.tooManyRules") : null)
              || t("errors.saveFailed"),
          );
          setIsError(true);
          return false;
        }
        setIsError(false);
        setRules((current) => {
          const next = { ...current };
          if (allowed.length === 0) delete next[offeredCardId];
          else next[offeredCardId] = allowed;
          return next;
        });
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
    if (!draft?.offeredCardId || draft.allowed.length === 0) return;
    if (await persist(draft.offeredCardId, draft.allowed)) {
      setMessage(t("messages.saved", { card: label(draft.offeredCardId) }));
      setDraft(null);
    }
  }, [draft, persist, label, t]);

  const handleRemove = useCallback(
    async (offeredCardId: string) => {
      if (await persist(offeredCardId, [])) {
        setMessage(t("messages.removed", { card: label(offeredCardId) }));
        setDraft((current) => (current?.offeredCardId === offeredCardId ? null : current));
      }
    },
    [persist, label, t],
  );

  const disabled = saving || isMaintenanceBlocked;
  // 出品カードに選べるのは、まだルールが無い有効なカード。
  const offeredChoices = cards.filter((card) => card.isActive && !(card.id in rules));
  // 許可カードに追加できるのは、出品カード自身と追加済みを除いた有効なカード。
  // 許可カードは1ルールにつき上限がある(API も同じ値で検証する)。上限に達したら追加を止める。
  const atItemLimit = (draft?.allowed.length ?? 0) >= TRADE_WANTED_RESTRICTION_MAX_ITEMS;
  const allowedChoices = draft?.offeredCardId && !atItemLimit
    ? cards.filter(
        (card) => card.isActive && card.id !== draft.offeredCardId && !draft.allowed.includes(card.id),
      )
    : [];
  const unchanged =
    draft?.offeredCardId != null
    && !draft.isNew
    && sameSet(draft.allowed, rules[draft.offeredCardId] ?? []);

  return (
    <div className="mt-6 border-t border-gray-700 pt-6" data-testid="trade-wanted-restriction-settings">
      <h3 className="text-lg font-semibold text-white">{t("title")}</h3>
      <p className="mt-1 text-sm text-gray-400">{t("description")}</p>
      <p className="mt-1 text-xs text-gray-500">{t("scopeNote")}</p>
      {isMaintenanceBlocked && (
        <p className="mt-2 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
      )}

      {ruleIds.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">{t("empty")}</p>
      ) : (
        <ul className="mt-4 space-y-3" aria-label={t("listLabel")}>
          {ruleIds.map((offeredCardId) => {
            const allowed = rules[offeredCardId];
            return (
              <li key={offeredCardId} className="rounded-lg bg-gray-700/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-white">{label(offeredCardId)}</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setDraft({ offeredCardId, allowed: [...allowed], isNew: false });
                        setMessage("");
                      }}
                      className="rounded-md bg-gray-600 px-3 py-1 text-xs text-white hover:bg-gray-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
                    >
                      {t("edit")}
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => void handleRemove(offeredCardId)}
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
                      <li
                        key={cardId}
                        className="rounded-full bg-gray-600 px-2 py-0.5 text-xs text-gray-100"
                      >
                        {label(cardId)}
                        {cardById.get(cardId)?.isActive === false && (
                          <span className="ml-1 text-yellow-300">{t("inactiveBadge")}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {draft ? (
        <div className="mt-4 space-y-3 rounded-lg border border-gray-600 p-3">
          <div>
            <label htmlFor={offeredSelectId} className="mb-1 block text-sm text-gray-300">
              {t("offeredLabel")}
            </label>
            <select
              id={offeredSelectId}
              value={draft.offeredCardId ?? ""}
              disabled={disabled || !draft.isNew}
              onChange={(event) =>
                setDraft({ ...draft, offeredCardId: event.target.value || null, allowed: [] })
              }
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              {draft.isNew ? (
                <>
                  <option value="">{t("offeredPlaceholder")}</option>
                  {offeredChoices.map((card) => (
                    <option key={card.id} value={card.id}>
                      {label(card.id)}
                    </option>
                  ))}
                </>
              ) : (
                <option value={draft.offeredCardId ?? ""}>
                  {draft.offeredCardId ? label(draft.offeredCardId) : ""}
                </option>
              )}
            </select>
          </div>

          {draft.offeredCardId && (
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
                  if (cardId) setDraft({ ...draft, allowed: [...draft.allowed, cardId] });
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
              {draft.allowed.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("allowedLabel")}>
                  {draft.allowed.map((cardId) => (
                    <li
                      key={cardId}
                      className="flex items-center gap-1 rounded-full bg-gray-600 px-2 py-0.5 text-xs text-gray-100"
                    >
                      {label(cardId)}
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={t("removeAllowed", { card: label(cardId) })}
                        onClick={() =>
                          setDraft({ ...draft, allowed: draft.allowed.filter((id) => id !== cardId) })
                        }
                        className="rounded-full px-1 text-gray-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-gray-500">{t("allowedEmptyHint")}</p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={disabled || !draft.offeredCardId || draft.allowed.length === 0 || unchanged}
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
        <button
          type="button"
          disabled={disabled || offeredChoices.length === 0}
          onClick={() => {
            setDraft({ offeredCardId: null, allowed: [], isNew: true });
            setMessage("");
          }}
          className="mt-4 rounded-lg bg-gray-600 px-4 py-2 text-sm text-white hover:bg-gray-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        >
          {t("add")}
        </button>
      )}

      {message && (
        <p role="status" className={`mt-3 text-sm ${isError ? "text-red-400" : "text-green-400"}`}>
          {message}
        </p>
      )}
    </div>
  );
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}
