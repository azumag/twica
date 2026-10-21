import GuideIcon, { type GuideIconName } from "./GuideIcon";

export type FaqEntry = {
  key: string;
  icon: GuideIconName;
  /** The message as the screen shows it ("...と表示された"). */
  question: string;
  /** Why it happens, one sentence. */
  reason: string;
  /** What to do about it, one sentence. */
  action: string;
};

type FaqAccordionProps = {
  items: readonly FaqEntry[];
  /** Row labels inside an opened entry ("Why" / "What to do"). */
  reasonLabel: string;
  actionLabel: string;
};

/**
 * "Troubleshooting" as native <details>/<summary>: opens and closes without any
 * JavaScript, is keyboard operable and announced as an expandable control by default.
 * The summary is the message the reader saw; inside, two labelled lines say why it
 * appeared and what to do. Each question gets a small icon for quick scanning; the
 * chevron turns when open (only the rotation is styled, so there is no animation to
 * opt out of).
 */
export default function FaqAccordion({ items, reasonLabel, actionLabel }: FaqAccordionProps) {
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
              className="mt-1.5 h-4 w-4 shrink-0 text-gray-300 group-open:rotate-90"
            />
          </summary>
          <dl className="space-y-2 px-4 pb-4 text-sm leading-relaxed text-gray-300 sm:pl-[3.75rem]">
            <div className="flex gap-2">
              <dt className="w-12 shrink-0 font-semibold text-purple-200">{reasonLabel}</dt>
              <dd className="min-w-0">{item.reason}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-12 shrink-0 font-semibold text-emerald-200">{actionLabel}</dt>
              <dd className="min-w-0">{item.action}</dd>
            </div>
          </dl>
        </details>
      ))}
    </div>
  );
}
