"use client";

import TradeCardSummary, { type TradeCardDisplay } from "./TradeCardSummary";

/** One selectable card tile. */
export type TradeCardChoice = {
  cardId: string;
  card: TradeCardDisplay;
  /** The tile cannot be chosen (e.g. same card as the offered one). */
  disabled?: boolean;
  /** Tooltip explaining why a tile is disabled. */
  title?: string;
  /**
   * Highlighted border for a card worth noticing (the listing flow marks
   * unowned cards: they are what the collector is missing, §6.5).
   */
  highlighted?: boolean;
  /** Small badge on the right (e.g. "unowned", "3 usable"). */
  badge?: React.ReactNode;
};

interface TradeCardChoiceListProps {
  choices: TradeCardChoice[];
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
  /** Every tile is disabled (a request is in flight). */
  disabled?: boolean;
}

const TILE_BASE =
  "flex w-full items-center rounded-xl border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400";

/**
 * Grid of card tiles where exactly one card is chosen (listing flow Step 2,
 * #1791 bid form).
 *
 * Extracted from TradeCreateForm's Step 2 so that the auction bid form uses
 * the same card picker (design §6: "カード選択は出品フロー Step 2 の UI を
 * 再利用"): the same tile, the same `aria-pressed` toggle semantics and the
 * same disabled/tooltip handling. Which cards are offered and why one is
 * disabled stays with the caller, because the two flows filter differently
 * (wanted cards may be unowned; bid cards must be owned and free).
 *
 * One column on narrow screens (375px), so long card names wrap instead of
 * causing horizontal scroll.
 */
export default function TradeCardChoiceList({
  choices,
  selectedCardId,
  onSelect,
  disabled = false,
}: TradeCardChoiceListProps) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {choices.map((choice) => {
        const selected = choice.cardId === selectedCardId;
        return (
          <li key={choice.cardId}>
            <button
              type="button"
              disabled={choice.disabled || disabled}
              aria-pressed={selected}
              title={choice.title}
              onClick={() => onSelect(choice.cardId)}
              className={`${TILE_BASE} ${
                selected
                  ? "border-purple-400 bg-purple-900/40"
                  : choice.highlighted
                    ? "border-purple-700/60 bg-gray-800 hover:bg-gray-700"
                    : "border-gray-700 bg-gray-800 hover:bg-gray-700"
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <div className="min-w-0 flex-1">
                <TradeCardSummary card={choice.card} />
              </div>
              {choice.badge}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
