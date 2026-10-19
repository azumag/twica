/**
 * Trade constants shared between the server trade module (@/lib/trade) and
 * the client trade UI (TradeCreateForm).
 *
 * Kept in a dependency-free module so client components can import a *value*:
 * @/lib/trade pulls in the DB layer, which must never be bundled for the
 * browser. (Issue #1789 wanted-quantity.)
 */

/** Upper bound of `trade_offers.wanted_quantity` (CHECK constraint mirrors it). */
export const TRADE_MAX_WANTED_QUANTITY = 10;

/** 1 .. TRADE_MAX_WANTED_QUANTITY, matching the DB CHECK and the UI selector. */
export const TRADE_WANTED_QUANTITY_OPTIONS = Array.from(
  { length: TRADE_MAX_WANTED_QUANTITY },
  (_, i) => i + 1,
) as ReadonlyArray<number>;

/** Total quantity of one request (minimum one, NOT NULL DEFAULT 1 in the DB). */
export const TRADE_MIN_WANTED_QUANTITY = 1;

export function isValidTradeWantedQuantity(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isInteger(value)
    && value >= TRADE_MIN_WANTED_QUANTITY
    && value <= TRADE_MAX_WANTED_QUANTITY
  );
}
