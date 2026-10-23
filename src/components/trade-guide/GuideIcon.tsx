import type { ReactNode } from "react";

/**
 * Inline SVG icons for the trade guide (/guide/trade).
 *
 * The project has no icon library and this guide must not add a dependency for a
 * dozen glyphs, so each icon is a small hand-written 24x24 stroke path set.
 * They all share one stroke style (currentColor, round caps/joins, 1.75 width) so
 * they pick up the surrounding text colour and look like one family.
 *
 * Icons are decorative: every place that uses one also shows text that says the
 * same thing, so the SVG is aria-hidden and not focusable. Meaning is never carried
 * by an icon alone.
 */
const ICON_PATHS = {
  // two opposite arrows: the "swap" mark used for every exchange in the guide
  swap: (
    <>
      <path d="M4 8h14" />
      <path d="M14 4l4 4-4 4" />
      <path d="M20 16H6" />
      <path d="M10 12l-4 4 4 4" />
    </>
  ),
  // gavel: tilted head, handle and the block it strikes
  gavel: (
    <>
      <rect x="9" y="2.5" width="9" height="5.5" rx="1.2" transform="rotate(45 13.5 5.25)" />
      <path d="M10.6 9.4L4.5 15.5" />
      <path d="M3 21h11" />
      <path d="M12.5 12.5l2 2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  xCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  sparkle: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0114 0" />
    </>
  ),
  login: (
    <>
      <path d="M10 8l4 4-4 4" />
      <path d="M14 12H3" />
      <path d="M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4" />
    </>
  ),
  bellOff: (
    <>
      <path d="M6 9a6 6 0 0110-4.5M18 9c0 4 2 5.5 2 6.5H8" />
      <path d="M5 15.5C6 14 6 12 6 9" />
      <path d="M10 19a2 2 0 004 0" />
      <path d="M4 4l16 16" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.3a2.5 2.5 0 114.2 1.8c-.9.8-1.7 1.2-1.7 2.4" />
      <path d="M12 16.6v.4" />
    </>
  ),
  cards: (
    <>
      <rect x="3.5" y="7" width="12" height="14" rx="2" />
      <path d="M8 4.5A2 2 0 0110 3h8a2 2 0 012 2v11a2 2 0 01-1.5 1.9" />
    </>
  ),
  toggle: (
    <>
      <rect x="2" y="7.5" width="20" height="9" rx="4.5" />
      <circle cx="16.5" cy="12" r="2.2" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M9.9 5.7A9.6 9.6 0 0112 5.5c6.4 0 10 6.5 10 6.5a17 17 0 01-3.2 3.9" />
      <path d="M6.3 7.4A17 17 0 002 12s3.6 6.5 10 6.5c1.5 0 2.9-.4 4.1-.9" />
      <path d="M9.9 9.9a3 3 0 004.2 4.2" />
      <path d="M4 4l16 16" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 4h8v5a4 4 0 01-8 0z" />
      <path d="M8 6H4v1a3 3 0 003 3M16 6h4v1a3 3 0 01-3 3" />
      <path d="M12 13v4M8.5 20h7" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h12l-2.5 4L17 12H5" />
    </>
  ),
  plusCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20l1-4L16.5 4.5a2 2 0 012.8 0l.2.2a2 2 0 010 2.8L8 19z" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </>
  ),
  tag: (
    <>
      <path d="M3 12.5V4h8.5l9 9a1.4 1.4 0 010 2l-5.5 5.5a1.4 1.4 0 01-2 0z" />
      <circle cx="7.5" cy="8.5" r="1.2" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l5 5" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </>
  ),
  arrowRight: <path d="M4 12h15M14 6l6 6-6 6" />,
  arrowDown: <path d="M12 4v15M6 14l6 6 6-6" />,
  chevronRight: <path d="M9 5l7 7-7 7" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A1.5 1.5 0 015.5 4H12v16H5.5A1.5 1.5 0 014 18.5z" />
      <path d="M12 4h6.5A1.5 1.5 0 0120 5.5v13a1.5 1.5 0 01-1.5 1.5H12" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type GuideIconName = keyof typeof ICON_PATHS;

/** Every icon name, for tests that check each glyph renders as a decorative SVG. */
export const GUIDE_ICON_NAMES = Object.keys(ICON_PATHS) as GuideIconName[];

type GuideIconProps = {
  name: GuideIconName;
  /** Tailwind size / colour classes; defaults to a 20px icon in the text colour. */
  className?: string;
};

export default function GuideIcon({ name, className = "h-5 w-5" }: GuideIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
