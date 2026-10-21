import GuideIcon, { type GuideIconName } from "./GuideIcon";

export type FaqEntry = {
  key: string;
  icon: GuideIconName;
  question: string;
  answer: string;
};

/**
 * FAQ as native <details>/<summary>: opens and closes without any JavaScript, is
 * keyboard operable and announced as an expandable control by default. Each question
 * gets a small icon for quick scanning; the chevron turns when open (only the
 * rotation is styled, so there is no animation to opt out of).
 */
export default function FaqAccordion({ items }: { items: readonly FaqEntry[] }) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <details key={item.key} className="group rounded-xl bg-gray-800">
          <summary className="flex cursor-pointer list-none items-start gap-3 rounded-xl p-4 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 [&::-webkit-details-marker]:hidden">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-200">
              <GuideIcon name={item.icon} className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 pt-1 font-semibold leading-snug">{item.question}</span>
            <GuideIcon
              name="chevronRight"
              className="mt-1.5 h-4 w-4 text-gray-300 group-open:rotate-90"
            />
          </summary>
          <p className="px-4 pb-4 pl-[3.75rem] text-sm leading-relaxed text-gray-300">{item.answer}</p>
        </details>
      ))}
    </div>
  );
}
