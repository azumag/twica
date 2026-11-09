import CardTile from "./CardTile";
import GuideIcon from "./GuideIcon";

type ExchangeFigureProps = {
  /** Short label of the left tile ("You give"). Keep it to a few characters: it never wraps. */
  giveLabel: string;
  /** Example card name under the left tile. */
  giveCard: string;
  /** "×2"-style badge on the left tile (an example quantity, not a rule). */
  giveBadge: string;
  /** Short label of the right tile ("You get" / "Card you want"). */
  wantLabel: string;
  /** Example card name under the right tile. */
  wantCard: string;
  /** "×3"-style badge on the right tile (an example quantity, not a rule). */
  wantBadge: string;
  /** Draw the right tile as a stack of cards (several copies change hands). */
  wantStacked?: boolean;
  /** Draw the left tile as a stack of cards. */
  giveStacked?: boolean;
  /** Text read out for the double arrow between the two tiles. */
  arrowLabel: string;
  caption: string;
};

/**
 * "This card goes out, that card comes in" swap diagram, with a worked example
 * (card names and copy counts). The caption states the same thing in words, so the
 * figure also works with the images unseen (screen readers, text-only mode).
 *
 * Both sides are props, so the same figure serves "accept someone's listing" (you give
 * the copies they want, you get their one card) and "create a listing" (you give one
 * card, you want several copies).
 */
export default function ExchangeFigure({
  giveLabel,
  giveCard,
  giveBadge,
  wantLabel,
  wantCard,
  wantBadge,
  wantStacked = false,
  giveStacked = false,
  arrowLabel,
  caption,
}: ExchangeFigureProps) {
  return (
    <figure className="rounded-xl bg-gray-800 p-5 sm:p-6">
      <div className="flex items-start justify-center gap-3 sm:gap-8">
        <CardTile tone="give" label={giveLabel} sublabel={giveCard} badge={giveBadge} stacked={giveStacked} />
        <div className="flex flex-col items-center self-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-purple-600 text-white shadow-lg shadow-purple-900/40 sm:h-14 sm:w-14">
            <GuideIcon name="swap" className="h-6 w-6 sm:h-7 sm:w-7" />
          </span>
          <span className="sr-only">{arrowLabel}</span>
        </div>
        <CardTile tone="want" label={wantLabel} sublabel={wantCard} badge={wantBadge} stacked={wantStacked} />
      </div>
      <figcaption className="mt-5 border-t border-gray-700 pt-4 text-sm leading-relaxed text-gray-300">
        {caption}
      </figcaption>
    </figure>
  );
}
