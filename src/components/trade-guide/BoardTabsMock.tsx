type BoardTabsMockProps = {
  /** Accessible name of the strip. */
  label: string;
  tradeButton: string;
  /** Board tab labels in screen order; the first one is drawn as the active tab. */
  tabs: readonly string[];
  myTradesLink: string;
};

/**
 * Static strip of the real board chrome: the collection page's "Trade" button, the
 * three board tabs (same classes as the board's tabClass) and the "My trades" link.
 * It shows the reader which words to look for on the screen.
 */
export default function BoardTabsMock({ label, tradeButton, tabs, myTradesLink }: BoardTabsMockProps) {
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-gray-900/60 p-3" role="group" aria-label={label}>
      <span className="inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white">
        {tradeButton}
      </span>
      <ul className="flex flex-wrap gap-2">
        {tabs.map((tab, index) => (
          <li
            key={tab}
            className={`rounded-lg px-4 py-2 text-sm ${
              index === 0 ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-300"
            }`}
          >
            {tab}
          </li>
        ))}
      </ul>
      <p className="text-sm text-purple-300">{myTradesLink}</p>
    </div>
  );
}
