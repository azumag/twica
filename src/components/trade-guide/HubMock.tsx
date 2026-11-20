import GuideIcon from "./GuideIcon";

type HubMockProps = {
  /** Accessible name of the strip. */
  label: string;
  /** Caption over the mini sidebar (e.g. "サイドバー"). */
  sidebarLabel: string;
  /** Sidebar item label (navigation.trade). */
  navItem: string;
  /** Hub heading (trade.hubTitle). */
  hubTitle: string;
  /** Primary create button on the hub (trade.hubCreateButton). */
  createButton: string;
  /** "マイトレード" section heading (trade.myTradesTitle). */
  myTradesTitle: string;
  /** "コレクション別の出品" section heading (trade.collectionsTitle). */
  collectionsTitle: string;
  /** The expand button with an example count (trade.collectionExpand). */
  expandButton: string;
};

/**
 * Static strip of the real trade-hub chrome: the sidebar's highlighted "Trade"
 * item (matching the active DashboardNav styles) and the hub's own
 * heading, "Create" button and section headings. It shows the reader which
 * words to look for on the screen: the sidebar is the entry, and the hub is
 * where listing, "My trades" and the per-collection lists live.
 */
export default function HubMock({
  label,
  sidebarLabel,
  navItem,
  hubTitle,
  createButton,
  myTradesTitle,
  collectionsTitle,
  expandButton,
}: HubMockProps) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2" role="group" aria-label={label}>
      <div className="space-y-2 rounded-lg bg-gray-900/60 p-3">
        <p className="text-xs text-gray-400">{sidebarLabel}</p>
        <span className="inline-flex items-center gap-3 rounded-lg bg-purple-600 px-3 py-2 text-sm font-medium text-white lg:border-s-2 lg:border-purple-400 lg:bg-purple-500/15 lg:text-purple-100">
          <GuideIcon name="swap" />
          {navItem}
        </span>
      </div>
      <div className="space-y-3 rounded-lg bg-gray-900/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xl font-bold text-white">{hubTitle}</span>
          <span className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white">
            {createButton}
          </span>
        </div>
        <p className="font-semibold text-white">{myTradesTitle}</p>
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-white">{collectionsTitle}</span>
          <span className="rounded-lg bg-gray-700 px-3 py-1 text-xs text-white">{expandButton}</span>
        </p>
      </div>
    </div>
  );
}
