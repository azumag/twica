import GuideIcon from "./GuideIcon";

/**
 * Colour roles for the two sides of a swap. The real trade screen is purple only
 * (TradeOfferRow tells the sides apart with the "もらう/渡す" text labels), which is
 * too subtle for a diagram whose whole point is "this goes out, that comes in".
 * So the guide adds a second visual channel: emerald = the card you give, sky = the
 * card you ask for. Colour is never the only signal: every tile also carries its
 * text label, so the diagram is still readable in monochrome or by a screen reader.
 */
export const SIDE_TONE = {
  give: {
    frame: "border-emerald-400/70",
    glow: "shadow-emerald-500/20",
    chip: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/40",
    art: "text-emerald-300/70",
  },
  want: {
    frame: "border-sky-400/70",
    glow: "shadow-sky-500/20",
    chip: "bg-sky-500/15 text-sky-200 ring-1 ring-sky-400/40",
    art: "text-sky-300/70",
  },
} as const;

export type SideTone = keyof typeof SIDE_TONE;

type CardTileProps = {
  tone: SideTone;
  /** Text label under the tile ("the card you give" / "the card you ask for"). */
  label: string;
  /** Optional second line (how many copies). */
  sublabel?: string;
  /** "×3"-style copies badge, same wording and purple badge as TradeCardSummary. */
  badge?: string;
  /** Draw extra cards behind the tile to suggest several copies. */
  stacked?: boolean;
  /** Smaller tile for the cross-channel diagram. */
  small?: boolean;
};

/**
 * Placeholder for a card image. A real card image would make the diagram depend on
 * data, so this draws a rarity-frame style card (framed art area + star row) instead.
 */
export default function CardTile({ tone, label, sublabel, badge, stacked = false, small = false }: CardTileProps) {
  const t = SIDE_TONE[tone];
  const size = small ? "h-20 w-14" : "h-28 w-20 sm:h-36 sm:w-28";
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 text-center">
      <div className="relative">
        {stacked && (
          <>
            <div
              aria-hidden="true"
              className={`absolute inset-0 translate-x-2 -translate-y-1.5 rotate-6 rounded-lg border-2 ${t.frame} bg-gray-800 opacity-60`}
            />
            <div
              aria-hidden="true"
              className={`absolute inset-0 translate-x-1 -translate-y-0.5 rotate-3 rounded-lg border-2 ${t.frame} bg-gray-800 opacity-80`}
            />
          </>
        )}
        <div
          aria-hidden="true"
          className={`relative flex ${size} flex-col items-center justify-between rounded-lg border-2 ${t.frame} bg-gradient-to-b from-gray-700 to-gray-800 p-1.5 shadow-lg ${t.glow}`}
        >
          {/* art area: a simple mountain-and-sun picture standing in for the card image */}
          <div className="flex w-full flex-1 items-center justify-center rounded bg-gray-900/70">
            <svg viewBox="0 0 40 30" className={`h-3/4 w-3/4 ${t.art}`} fill="currentColor">
              <circle cx="29" cy="8" r="4" />
              <path d="M2 28l11-16 7 9 5-6 13 13z" />
            </svg>
          </div>
          {/* rarity-style star row under the art */}
          <div className={`mt-1 flex gap-0.5 ${t.art}`}>
            {[0, 1, 2].map((star) => (
              <svg key={star} viewBox="0 0 10 10" className={small ? "h-2 w-2" : "h-2.5 w-2.5"} fill="currentColor">
                <path d="M5 .5l1.3 3 3.2.3-2.4 2.1.7 3.1L5 7.4 2.2 9l.7-3.1L.5 3.8l3.2-.3z" />
              </svg>
            ))}
          </div>
          {badge && (
            <span className="absolute -right-2 -top-2 rounded bg-purple-600 px-1.5 py-0.5 text-xs font-semibold text-white">
              {badge}
            </span>
          )}
        </div>
      </div>
      {/* The label is optional: the cross-channel diagram names its tiles in the
          captions next to them instead (a pill would not fit under a 56px tile). */}
      {label && (
        <p className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold sm:text-sm ${t.chip}`}>
          <GuideIcon name={tone === "give" ? "arrowRight" : "cards"} className="h-3.5 w-3.5" />
          {label}
        </p>
      )}
      {sublabel && <p className="text-xs text-gray-300">{sublabel}</p>}
    </div>
  );
}
