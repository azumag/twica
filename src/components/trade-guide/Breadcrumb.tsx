import GuideIcon from "./GuideIcon";

type BreadcrumbProps = {
  /** Accessible name and visible lead-in ("Where to find it"). */
  label: string;
  /** Screen labels in click order. Taken from the real menu / heading messages. */
  items: readonly string[];
};

/**
 * "A > B > C" path chips showing where a setting lives. The labels come from the
 * messages of the screens themselves, so the path matches what the streamer sees.
 */
export default function Breadcrumb({ label, items }: BreadcrumbProps) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-xs font-semibold text-gray-300">{label}</span>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm">
        {items.map((item, index) => (
          <li key={item} className="flex items-center gap-1.5">
            {index > 0 && <GuideIcon name="chevronRight" className="h-3.5 w-3.5 text-gray-400" />}
            <span
              className={`rounded-md px-2 py-1 ${
                index === items.length - 1 ? "bg-purple-600 text-white" : "bg-gray-700 text-gray-100"
              }`}
            >
              {item}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
