import GuideIcon, { type GuideIconName } from "./GuideIcon";

type ModeCardProps = {
  /** In-page anchor of the section this card jumps to. */
  href: string;
  icon: GuideIconName;
  title: string;
  tagline: string;
  chips: readonly string[];
  tone: "offer" | "auction";
};

const TONE = {
  offer: {
    card: "border-purple-500/40 bg-gradient-to-br from-purple-900/40 to-gray-800 hover:border-purple-400",
    icon: "bg-purple-600 text-white",
    chip: "bg-purple-500/15 text-purple-100 ring-1 ring-purple-400/40",
  },
  auction: {
    card: "border-amber-500/40 bg-gradient-to-br from-amber-900/30 to-gray-800 hover:border-amber-400",
    icon: "bg-amber-600 text-white",
    chip: "bg-amber-500/15 text-amber-100 ring-1 ring-amber-400/40",
  },
} as const;

/**
 * Big "which mode?" card at the top of the guide. The whole card is one link to the
 * matching section, so a first-time reader can pick a mode before reading anything.
 */
export default function ModeCard({ href, icon, title, tagline, chips, tone }: ModeCardProps) {
  const c = TONE[tone];
  return (
    <a
      href={href}
      className={`group flex flex-col gap-4 rounded-2xl border p-5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 ${c.card}`}
    >
      <div className="flex items-center gap-4">
        <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ${c.icon}`}>
          <GuideIcon name={icon} className="h-8 w-8" />
        </span>
        <div className="min-w-0">
          <p className="text-xl font-bold text-white">{title}</p>
          <p className="mt-0.5 text-sm text-gray-200">{tagline}</p>
        </div>
        <GuideIcon
          name="arrowDown"
          className="ml-auto h-5 w-5 text-gray-300 transition-transform motion-safe:group-hover:translate-y-0.5"
        />
      </div>
      <ul className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <li key={chip} className={`rounded-full px-3 py-1 text-xs font-semibold sm:text-sm ${c.chip}`}>
            {chip}
          </li>
        ))}
      </ul>
    </a>
  );
}
