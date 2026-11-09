import GuideIcon from "./GuideIcon";

export type VisibilityRow = {
  key: string;
  /** What is being asked ("name and image of cards the viewer does not own"). */
  aspect: string;
  /** Result when unowned cards are revealed. */
  revealed: { ok: boolean; text: string };
  /** Result when they are hidden. */
  hidden: { ok: boolean; text: string };
};

type VisibilityTableProps = {
  caption: string;
  aspectHeader: string;
  revealedHeader: string;
  hiddenHeader: string;
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
 * Small matrix: what a viewer can see / pick, for each unowned-card visibility setting.
 *
 * The settings are the columns (two states) and the questions are the rows, rather
 * than the other way round: with two narrow columns plus the row header the table
 * still fits a 360px screen without sideways scrolling. Every cell has a check/cross
 * icon AND text, so no cell relies on colour.
 */
export default function VisibilityTable({
  caption,
  aspectHeader,
  revealedHeader,
  hiddenHeader,
  rows,
}: VisibilityTableProps) {
  return (
    <div className="overflow-hidden rounded-xl bg-gray-800 ring-1 ring-gray-700">
      <table className="w-full table-fixed border-collapse text-left text-xs sm:text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-gray-700/60 text-gray-100">
            <th scope="col" className="w-[34%] px-2 py-2 font-semibold sm:px-3">
              {aspectHeader}
            </th>
            <th scope="col" className="px-2 py-2 font-semibold sm:px-3">
              <span className="inline-flex items-center gap-1">
                <GuideIcon name="eye" className="h-4 w-4 shrink-0 text-emerald-300" />
                {revealedHeader}
              </span>
            </th>
            <th scope="col" className="px-2 py-2 font-semibold sm:px-3">
              <span className="inline-flex items-center gap-1">
                <GuideIcon name="eyeOff" className="h-4 w-4 shrink-0 text-rose-300" />
                {hiddenHeader}
              </span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-700">
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="px-2 py-3 align-top font-semibold text-gray-100 sm:px-3">
                {row.aspect}
              </th>
              <Cell ok={row.revealed.ok} text={row.revealed.text} />
              <Cell ok={row.hidden.ok} text={row.hidden.text} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
