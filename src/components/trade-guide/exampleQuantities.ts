/**
 * Example numbers used by the worked examples on /guide/trade (the "x2" and "x3" in
 * the card diagrams and the example sentences).
 *
 * These are NOT rules, only "what it looks like with these numbers", so they live apart
 * from the limits (which the page takes from the server's own constants). A test keeps
 * every value inside the range the server accepts, so an example can never show a trade
 * the app would refuse.
 */

/** Accepting a listing: you give EXAMPLE_ACCEPT_GIVE copies and get EXAMPLE_ACCEPT_GET card. */
export const EXAMPLE_ACCEPT_GIVE = 2;
export const EXAMPLE_ACCEPT_GET = 1;

/** Creating a listing: you give EXAMPLE_OFFER_GIVE card and want EXAMPLE_OFFER_WANT copies. */
export const EXAMPLE_OFFER_GIVE = 1;
export const EXAMPLE_OFFER_WANT = 3;

/** The auction example: the card is listed for this many hours (one of the real durations). */
export const EXAMPLE_AUCTION_DURATION_HOURS = 72;

/** The auction example: three bids; `picked` is the one the seller chooses. */
export const EXAMPLE_AUCTION_BIDS = [
  { key: "slime", quantity: 3, picked: false },
  { key: "golem", quantity: 1, picked: true },
  { key: "pixie", quantity: 2, picked: false },
] as const;
