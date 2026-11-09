import GuideIcon, { type GuideIconName } from "./GuideIcon";

export type RuleItem = {
  key: string;
  icon: GuideIconName;
  text: string;
  /** "ban" rules (things you cannot do) get a red-ish icon so they stand out from plain facts. */
  kind?: "fact" | "ban";
};

/**
 * Rules as a grid of icon chips: one rule per chip, an icon that says the rule's
 * shape (lock, ban, globe...) and the sentence next to it.
 */
export default function RuleList({
  items,
  columns = 2,
}: {
  items: readonly RuleItem[];
  /** 2 = two columns from `md` up (short rules); 1 = one per row (long sentences). */
  columns?: 1 | 2;
}) {
  return (
    <ul className={`grid gap-2 ${columns === 2 ? "md:grid-cols-2" : ""}`}>
      {items.map((item) => (
        <li key={item.key} className="flex items-start gap-3 rounded-xl bg-gray-800 p-3 text-sm leading-relaxed text-gray-200">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              item.kind === "ban" ? "bg-rose-500/15 text-rose-300" : "bg-purple-500/15 text-purple-200"
            }`}
          >
            <GuideIcon name={item.icon} className="h-4 w-4" />
          </span>
          <span className="min-w-0 pt-1">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}
