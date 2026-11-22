import GuideIcon, { type GuideIconName } from "./GuideIcon";

/** One state of the unowned-card visibility settings (a column). */
export type VisibilityColumn = {
  key: string;
  header: string;
  icon: GuideIconName;
};

export type VisibilityRow = {
  key: string;
  /** What is being asked ("name and image of cards the viewer does not own"). */
  aspect: string;
  /** One cell per column, in the same order as the `columns` prop. */
  cells: readonly { ok: boolean; text: string }[];
};

type VisibilityTableProps = {
  caption: string;
  aspectHeader: string;
  columns: readonly VisibilityColumn[];
  rows: readonly VisibilityRow[];
};

function Cell({ ok, text }: { ok: boolean; text: string }) {
  return (
    <td className="px-2 py-3 align-top sm:px-3">
      <span className="flex items-start gap-1.5">
        <span
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
            ok ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
          }`}
        >
          <GuideIcon name={ok ? "check" : "x"} className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 text-gray-100">{text}</span>
      </span>
    </td>
  );
}

/**
 * Small matrix: what a viewer can see / pick, for each unowned-card visibility
 * setting. #2070 フォローアップ (C4b) made the setting item-level, so the
 * columns are "all items / some items / unowned cards hidden" and the
 * questions are the rows. Every cell has a check/cross icon AND text, so no
 * cell relies on colour, and the row headers keep the table readable at 360px.
 */
export default function VisibilityTable({
  caption,
  aspectHeader,
  columns,
  rows,
}: VisibilityTableProps) {
  return (
    <div className="overflow-hidden rounded-xl bg-gray-800 ring-1 ring-gray-700">
      <table className="w-full table-fixed border-collapse text-left text-xs sm:text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-gray-700/60 text-gray-100">
            <th scope="col" className="w-[28%] px-2 py-2 font-semibold sm:px-3">
              {aspectHeader}
            </th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className="px-2 py-2 font-semibold sm:px-3">
                <span className="inline-flex items-center gap-1">
                  <GuideIcon name={column.icon} className="h-4 w-4 shrink-0 text-purple-300" />
                  {column.header}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-700">
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="px-2 py-3 align-top font-semibold text-gray-100 sm:px-3">
                {row.aspect}
              </th>
              {row.cells.map((cell, index) => (
                <Cell key={columns[index]?.key ?? index} ok={cell.ok} text={cell.text} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
