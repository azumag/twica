/**
 * Status chip look, copied from the real auction status badge.
 *
 * TradeAuctionStatus.tsx is a client component (it ticks a countdown), and a server
 * component cannot read a plain constant out of a client-component module, so the
 * class table is repeated here. tests/unit/public-help-pages.test.ts reads that
 * file and fails if any of these class strings stops appearing in it, which keeps
 * the guide's chips from silently drifting away from the screen.
 */
export const PHASE_CHIP_CLASS = {
  bidding: "bg-emerald-700 text-emerald-50",
  selecting: "bg-yellow-700 text-yellow-50",
  completed: "bg-purple-700 text-white",
  expired: "bg-gray-600 text-gray-100",
  cancelled: "bg-gray-600 text-gray-100",
  // The "bid can't be completed" badge on bid rows (TradeAuctionRow / TradeAuctionDetail).
  unsettleable: "bg-yellow-700 text-yellow-50",
} as const;

export type PhaseChipKey = keyof typeof PHASE_CHIP_CLASS;

export type PhaseChipItem = {
  key: PhaseChipKey;
  /** The label exactly as the screen shows it (trade.auctionPhase*). */
  label: string;
  description: string;
};

/** Status chips with a one-line meaning each: "how to read the badge on the board". */
export default function PhaseChips({ items }: { items: readonly PhaseChipItem[] }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <li key={item.key} className="flex flex-col gap-2 rounded-xl bg-gray-800 p-3">
          <span className={`w-fit rounded px-2 py-0.5 text-xs ${PHASE_CHIP_CLASS[item.key]}`}>{item.label}</span>
          <span className="text-sm leading-relaxed text-gray-300">{item.description}</span>
        </li>
      ))}
    </ul>
  );
}
