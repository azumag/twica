import GuideIcon from "./GuideIcon";
import { PHASE_CHIP_CLASS } from "./PhaseChips";

type AuctionTimelineProps = {
  biddingChip: string;
  biddingTitle: string;
  biddingDescription: string;
  /** The real duration labels ("24 hours" / "3 days" / "7 days") as shown in the listing form. */
  durationLabels: readonly string[];
  deadlineLabel: string;
  selectingChip: string;
  selectingTitle: string;
  selectingDescription: string;
  /** "Up to 72 hours". */
  maxHoursLabel: string;
  outcomeLabel: string;
  completedChip: string;
  completedDescription: string;
  expiredChip: string;
  expiredDescription: string;
  noBidsNote: string;
  caption: string;
};

/**
 * The auction's whole life in one picture:
 *
 *   [ taking bids ] -> (deadline) -> [ seller picks ] -> completed | no deal
 *
 * Wide screens lay it out left to right (the "long bar" reading); below `md` the
 * same <ol> stacks into a vertical timeline, so nothing scrolls sideways at 360px.
 * Using one list for both layouts (instead of two hidden/shown copies) keeps the
 * text in the DOM exactly once for assistive technology.
 *
 * The phase chips reuse the real status chip classes (PhaseChips), so "Taking bids"
 * here looks exactly like the badge on the auction board.
 */
export default function AuctionTimeline(props: AuctionTimelineProps) {
  // Arrow after a node. It is drawn by the node's own <li> (absolutely placed in the gap
  // to the next node) rather than as a list item of its own: an <ol> may only contain
  // <li>, and a presentational arrow must not be announced as a step.
  const connector = (
    <span
      aria-hidden="true"
      className="absolute left-1/2 top-full z-10 -translate-x-1/2 text-gray-400 md:left-full md:top-1/2 md:-translate-y-1/2 md:translate-x-0"
    >
      <GuideIcon name="arrowDown" className="h-6 w-6 md:-rotate-90" />
    </span>
  );
  return (
    <figure className="rounded-xl bg-gray-800 p-4 sm:p-5">
      <ol className="flex flex-col items-stretch gap-8 md:flex-row md:items-stretch md:gap-7">
        {/* 1. bidding window */}
        <li className="relative flex-[2.6] rounded-xl border border-emerald-500/50 bg-emerald-500/10 p-4">
          <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${PHASE_CHIP_CLASS.bidding}`}>
            {props.biddingChip}
          </span>
          <p className="mt-2 font-semibold text-white">{props.biddingTitle}</p>
          {/* a bar split in three: the three durations the seller can pick from */}
          <ul className="mt-3 flex overflow-hidden rounded-lg text-center text-xs font-semibold text-emerald-50 sm:text-sm">
            {props.durationLabels.map((label) => (
              <li key={label} className="flex-1 whitespace-nowrap border-r border-emerald-950/60 bg-emerald-700 px-1 py-2 last:border-r-0">
                {label}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-gray-300">{props.biddingDescription}</p>
          {connector}
        </li>

        {/* deadline marker */}
        <li className="relative flex items-center justify-center md:w-20 md:flex-col">
          <span className="flex items-center gap-2 rounded-full bg-gray-900 px-3 py-2 text-sm font-semibold text-white ring-2 ring-purple-400 md:flex-col md:rounded-2xl md:px-3 md:py-3">
            <GuideIcon name="flag" className="h-5 w-5 text-purple-300" />
            {props.deadlineLabel}
          </span>
          {connector}
        </li>

        {/* 2. seller picks */}
        <li className="relative flex-[2.1] rounded-xl border border-yellow-500/50 bg-yellow-500/10 p-4">
          <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${PHASE_CHIP_CLASS.selecting}`}>
            {props.selectingChip}
          </span>
          <p className="mt-2 font-semibold text-white">{props.selectingTitle}</p>
          <p className="mt-3 flex items-center gap-2 rounded-lg bg-yellow-700 px-3 py-2 text-xs font-semibold text-yellow-50 sm:text-sm">
            <GuideIcon name="clock" className="h-4 w-4" />
            {props.maxHoursLabel}
          </p>
          <p className="mt-2 text-sm text-gray-300">{props.selectingDescription}</p>
          {connector}
        </li>

        {/* 3. fork: the two possible endings */}
        <li className="flex flex-[2.2] flex-col gap-2">
          <p className="text-xs font-semibold text-gray-300">{props.outcomeLabel}</p>
          <div className="flex-1 rounded-xl border border-purple-500/50 bg-purple-500/10 p-3">
            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${PHASE_CHIP_CLASS.completed}`}>
              <GuideIcon name="check" className="h-3.5 w-3.5" />
              {props.completedChip}
            </span>
            <p className="mt-1.5 text-xs leading-relaxed text-gray-300">{props.completedDescription}</p>
          </div>
          <div className="flex-1 rounded-xl border border-gray-500/60 bg-gray-700/40 p-3">
            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${PHASE_CHIP_CLASS.expired}`}>
              <GuideIcon name="x" className="h-3.5 w-3.5" />
              {props.expiredChip}
            </span>
            <p className="mt-1.5 text-xs leading-relaxed text-gray-300">{props.expiredDescription}</p>
          </div>
        </li>
      </ol>

      {/* shortcut: no bids at all ends the auction at the deadline */}
      <p className="mt-4 flex items-start gap-2 rounded-lg border border-dashed border-gray-500 p-3 text-sm text-gray-200">
        <GuideIcon name="flag" className="mt-0.5 h-4 w-4 text-gray-300" />
        <span>{props.noBidsNote}</span>
      </p>

      <figcaption className="mt-3 text-xs leading-relaxed text-gray-300">{props.caption}</figcaption>
    </figure>
  );
}
