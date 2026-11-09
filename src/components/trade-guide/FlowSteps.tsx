import GuideIcon, { type GuideIconName } from "./GuideIcon";

export type FlowStep = {
  icon: GuideIconName;
  title: string;
  description: string;
};

type FlowStepsProps = {
  steps: readonly FlowStep[];
  /**
   * "row": side by side from `md` up (vertical below), for full-width flows.
   * "column": always vertical, for flows placed in a narrow column next to another one.
   */
  layout?: "row" | "column";
  /** Tailwind accent for the connector arrows and icon boxes. */
  accent?: "purple" | "emerald" | "sky";
};

const ACCENT = {
  purple: { box: "bg-purple-500/15 text-purple-200", num: "bg-purple-600", arrow: "text-purple-300" },
  emerald: { box: "bg-emerald-500/15 text-emerald-200", num: "bg-emerald-600", arrow: "text-emerald-300" },
  sky: { box: "bg-sky-500/15 text-sky-200", num: "bg-sky-600", arrow: "text-sky-300" },
} as const;

// Literal class names (Tailwind cannot see `md:grid-cols-${n}` built at runtime).
const ROW_COLUMNS: Record<number, string> = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
};

/**
 * Numbered flow: circle number + icon + short label + one-line note per step,
 * joined by arrows. It is an <ol>, so the order is announced as a list; the number
 * comes from the array index so inserting a step never leaves a stale number.
 *
 * The arrow after a step is drawn by that step's <li> (absolutely positioned in the
 * gap), pointing down in the vertical layout and right in the row layout.
 */
export default function FlowSteps({ steps, layout = "row", accent = "purple" }: FlowStepsProps) {
  const a = ACCENT[accent];
  const grid = layout === "row" ? `md:grid ${ROW_COLUMNS[steps.length] ?? "md:grid-cols-3"}` : "";
  return (
    <ol className={`flex flex-col gap-7 md:gap-8 ${grid}`}>
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        return (
          <li key={step.title} className="relative rounded-xl bg-gray-800 p-4">
            <div className="mb-2 flex items-center gap-3">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white ${a.num}`}
              >
                {index + 1}
              </span>
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${a.box}`}>
                <GuideIcon name={step.icon} className="h-5 w-5" />
              </span>
              <span className="min-w-0 font-semibold text-white">{step.title}</span>
            </div>
            <p className="text-sm leading-relaxed text-gray-300">{step.description}</p>
            {!isLast && (
              <span
                aria-hidden="true"
                className={`absolute left-1/2 top-full z-10 -translate-x-1/2 ${
                  layout === "row"
                    ? "md:left-full md:top-1/2 md:-translate-y-1/2 md:translate-x-0"
                    : ""
                }`}
              >
                <GuideIcon
                  name="arrowDown"
                  className={`h-6 w-6 ${a.arrow} ${layout === "row" ? "md:-rotate-90" : ""}`}
                />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
