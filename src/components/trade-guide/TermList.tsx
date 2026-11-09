export type TermItem = {
  key: string;
  term: string;
  description: string;
};

/**
 * The three words the guide uses for everything (list / accept / bid), one line each.
 * A real description list, so a screen reader announces term and meaning as a pair.
 */
export default function TermList({ label, items }: { label: string; items: readonly TermItem[] }) {
  return (
    <dl aria-label={label} className="grid gap-2 md:grid-cols-3">
      {items.map((item) => (
        <div key={item.key} className="rounded-xl bg-gray-800 p-3">
          <dt className="font-semibold text-purple-200">{item.term}</dt>
          <dd className="mt-1 text-sm leading-relaxed text-gray-300">{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}
