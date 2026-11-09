import GuideIcon, { type GuideIconName } from "./GuideIcon";

/**
 * One short sentence that must not be missed (a deadline, something that cannot be
 * undone). Icon + text, never colour alone.
 */
export default function Callout({ icon, children }: { icon: GuideIconName; children: string }) {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm leading-relaxed text-yellow-50">
      <GuideIcon name={icon} className="mt-0.5 h-5 w-5 shrink-0 text-yellow-300" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
