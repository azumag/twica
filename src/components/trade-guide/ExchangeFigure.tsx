import CardTile from "./CardTile";
import GuideIcon from "./GuideIcon";

type ExchangeFigureProps = {
  giveLabel: string;
  giveCount: string;
  wantLabel: string;
  wantCount: string;
  /** "×3"-style badge on the wanted card (an example quantity, not a rule). */
  wantBadge: string;
  /** Text read out for the double arrow between the two tiles. */
  arrowLabel: string;
  caption: string;
};

/**
 * "You give 1 card, you get N copies" swap diagram for a regular listing.
 * The caption states the same thing in words, so the figure also works with the
 * images unseen (screen readers, text-only mode).
 */
export default function ExchangeFigure({
  giveLabel,
  giveCount,
  wantLabel,
  wantCount,
  wantBadge,
  arrowLabel,
  caption,
}: ExchangeFigureProps) {
  return (
    <figure className="rounded-xl bg-gray-800 p-5 sm:p-6">
      <div className="flex items-start justify-center gap-3 sm:gap-8">
        <CardTile tone="give" label={giveLabel} sublabel={giveCount} badge="×1" />
        <div className="flex flex-col items-center self-center pt-0 sm:pt-0">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-purple-600 text-white shadow-lg shadow-purple-900/40 sm:h-14 sm:w-14">
            <GuideIcon name="swap" className="h-6 w-6 sm:h-7 sm:w-7" />
          </span>
          <span className="sr-only">{arrowLabel}</span>
        </div>
        <CardTile tone="want" label={wantLabel} sublabel={wantCount} badge={wantBadge} stacked />
      </div>
      <figcaption className="mt-5 border-t border-gray-700 pt-4 text-sm leading-relaxed text-gray-300">
        {caption}
      </figcaption>
    </figure>
  );
}
