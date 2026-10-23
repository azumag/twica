import GuideIcon, { type GuideIconName } from "./GuideIcon";

type ModeCardProps = {
  /** In-page anchor of the section this card jumps to. */
  href: string;
  icon: GuideIconName;
  /** Letter that ties the card to its section ("A" / "B" / "C"). */
  badge: string;
  title: string;
  description: string;
  tone: "accept" | "offer" | "auction";
};

const TONE = {
  accept: {
    card: "border-sky-500/40 bg-gradient-to-br from-sky-900/30 to-gray-800 hover:border-sky-400",
    icon: "bg-sky-600 text-white",
    badge: "bg-sky-500/20 text-sky-100 ring-1 ring-sky-400/50",
  },
  offer: {
    card: "border-purple-500/40 bg-gradient-to-br from-purple-900/40 to-gray-800 hover:border-purple-400",
    icon: "bg-purple-600 text-white",
    badge: "bg-purple-500/20 text-purple-100 ring-1 ring-purple-400/50",
  },
  auction: {
    card: "border-amber-500/40 bg-gradient-to-br from-amber-900/30 to-gray-800 hover:border-amber-400",
    icon: "bg-amber-600 text-white",
    badge: "bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/50",
  },
} as const;

/**
 * Big "which one do I use?" card at the top of the guide. The whole card is one link to
 * the matching section, so a first-time reader can pick what they want to do before
 * reading anything. The letter badge is repeated on the section heading it leads to.
 */
export default function ModeCard({ href, icon, badge, title, description, tone }: ModeCardProps) {
  const c = TONE[tone];
  return (
    <a
      href={href}
      className={`group flex items-start gap-4 rounded-2xl border p-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 sm:p-5 ${c.card}`}
    >
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl sm:h-14 sm:w-14 ${c.icon}`}>
        <GuideIcon name={icon} className="h-7 w-7 sm:h-8 sm:w-8" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-lg font-bold leading-snug text-white">
          <span
            aria-hidden="true"
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${c.badge}`}
          >
            {badge}
          </span>
          <span className="min-w-0">{title}</span>
        </p>
        <p className="mt-1 text-sm leading-relaxed text-gray-200">{description}</p>
      </div>
      <GuideIcon
        name="arrowDown"
        className="mt-1 hidden h-5 w-5 shrink-0 text-gray-300 transition-transform sm:block motion-safe:group-hover:translate-y-0.5"
      />
    </a>
  );
}
