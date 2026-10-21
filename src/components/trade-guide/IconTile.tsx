import type { ReactNode } from "react";
import GuideIcon, { type GuideIconName } from "./GuideIcon";

type IconTileProps = {
  icon: GuideIconName;
  title: string;
  description: string;
  /** Heading level of the title; follows the surrounding section so the outline has no gaps. */
  as?: "h3" | "h4";
  /** Extra visual under the text (e.g. the board tab strip). */
  children?: ReactNode;
};

/**
 * Icon + short heading + one or two sentences. The basic "point" card of the guide
 * (used 2x2 for the key points and for the getting-started facts).
 */
export default function IconTile({ icon, title, description, as: Heading = "h4", children }: IconTileProps) {
  return (
    <div className="flex gap-3 rounded-xl bg-gray-800 p-4">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-200">
        <GuideIcon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <Heading className="font-semibold text-white">{title}</Heading>
        <p className="mt-1 text-sm leading-relaxed text-gray-300">{description}</p>
        {children}
      </div>
    </div>
  );
}
