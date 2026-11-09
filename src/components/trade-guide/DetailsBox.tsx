import type { ReactNode } from "react";
import GuideIcon from "./GuideIcon";

/**
 * Collapsed "details" block at the end of a section: rules and exceptions that a first
 * read does not need. Native <details>/<summary>, so it opens and closes without any
 * JavaScript, is keyboard operable and is announced as an expandable control. Only the
 * chevron rotation is styled (no animation to opt out of).
 */
export default function DetailsBox({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group mt-6 rounded-xl border border-gray-700 bg-gray-800/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl p-4 font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 [&::-webkit-details-marker]:hidden">
        <GuideIcon name="chevronRight" className="h-4 w-4 shrink-0 text-gray-300 group-open:rotate-90" />
        <span className="min-w-0">{summary}</span>
      </summary>
      <div className="space-y-4 px-4 pb-4">{children}</div>
    </details>
  );
}
