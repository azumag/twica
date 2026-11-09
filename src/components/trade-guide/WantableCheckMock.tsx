import GuideIcon from "./GuideIcon";

type WantableCheckMockProps = {
  /** cardManager.form.tradeWantable: the real checkbox label on the card edit screen. */
  label: string;
  checkedCaption: string;
  uncheckedCaption: string;
};

/**
 * The "can be requested in trades" checkbox of the card edit screen (CardManager),
 * drawn twice: checked (the default) and unchecked. The real checkbox is a native
 * input with accent-purple-500; here it is a drawn box so the page has no form
 * controls that look clickable but do nothing. Each box is paired with a caption
 * that has an icon and words, so the state is not only the box colour.
 */
export default function WantableCheckMock({ label, checkedCaption, uncheckedCaption }: WantableCheckMockProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[
        { checked: true, caption: checkedCaption },
        { checked: false, caption: uncheckedCaption },
      ].map((state) => (
        <div key={state.caption} className="rounded-xl bg-gray-800 p-4 ring-1 ring-gray-700">
          <div className="flex items-start gap-2 text-sm text-gray-200">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded ${
                state.checked ? "bg-purple-500 text-white" : "border border-gray-400 bg-gray-700"
              }`}
            >
              {state.checked && <GuideIcon name="check" className="h-3 w-3" />}
            </span>
            <span>{label}</span>
          </div>
          <p
            className={`mt-3 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
              state.checked ? "bg-emerald-500/15 text-emerald-200" : "bg-rose-500/15 text-rose-200"
            }`}
          >
            <GuideIcon name={state.checked ? "check" : "x"} className="h-3.5 w-3.5" />
            {state.caption}
          </p>
        </div>
      ))}
    </div>
  );
}
