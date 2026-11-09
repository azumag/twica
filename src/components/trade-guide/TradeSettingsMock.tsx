type TradeSettingsMockProps = {
  /** "Card Trading Settings" etc. — tradeSettings.* messages, same wording as the real panel. */
  title: string;
  statusEnabled: string;
  statusDisabled: string;
  tradeEnabledLabel: string;
  tradeEnabledHelp: string;
  crossLabel: string;
  crossHelp: string;
  requiresTradeEnabled: string;
  /** Text next to each switch, so ON/OFF is never conveyed by the switch colour alone. */
  stateOn: string;
  stateOff: string;
  /** Whether the "trade" switch (and so the panel status) is on. */
  tradeEnabled: boolean;
  /** Whether the cross-channel switch is on (only meaningful when tradeEnabled). */
  crossEnabled: boolean;
  /** Short heading above the panel ("When trading is ON"). */
  caption: string;
};

/**
 * Non-interactive copy of the "Card Trading Settings" panel (TradeSettings.tsx).
 *
 * The real panel is a client component that loads and saves the streamer's settings,
 * so it cannot be reused on a public page. This redraws only its look with the same
 * Tailwind classes (card, status pill, 44x24 purple switch with a white knob, the
 * dimmed cross switch when trading is off), so the reader recognises it on sight.
 * One deliberate change: the help text uses text-gray-400 instead of the real
 * text-gray-500, which is too low in contrast on bg-gray-800 for a page whose job is
 * to be read.
 */
export default function TradeSettingsMock(props: TradeSettingsMockProps) {
  const crossDimmed = !props.tradeEnabled;
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-semibold text-gray-200">{props.caption}</figcaption>
      <div className="rounded-xl bg-gray-800 p-5 ring-1 ring-gray-700">
        <div className="mb-4 flex items-center justify-between gap-2">
          <p className="min-w-0 text-lg font-semibold text-white">{props.title}</p>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs ${
              props.tradeEnabled ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-400"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${props.tradeEnabled ? "bg-green-500" : "bg-gray-500"}`} />
            {props.tradeEnabled ? props.statusEnabled : props.statusDisabled}
          </span>
        </div>
        <div className="space-y-4">
          <ToggleRow
            checked={props.tradeEnabled}
            label={props.tradeEnabledLabel}
            help={props.tradeEnabledHelp}
            stateText={props.tradeEnabled ? props.stateOn : props.stateOff}
          />
          <ToggleRow
            checked={props.crossEnabled && props.tradeEnabled}
            label={props.crossLabel}
            help={props.crossHelp}
            stateText={props.crossEnabled && props.tradeEnabled ? props.stateOn : props.stateOff}
            dimmed={crossDimmed}
          />
          {crossDimmed && <p className="-mt-2 ml-14 text-xs text-gray-400">{props.requiresTradeEnabled}</p>}
        </div>
      </div>
    </figure>
  );
}

function ToggleRow({
  checked,
  label,
  help,
  stateText,
  dimmed = false,
}: {
  checked: boolean;
  label: string;
  help: string;
  stateText: string;
  dimmed?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        {/* Same switch geometry as TradeSettings' ToggleRow: the knob is the ::after
            of the track and moves with translate-x-full when on. aria-hidden because
            the ON/OFF text next to it carries the state. */}
        <span aria-hidden="true" className="relative inline-flex shrink-0 items-center">
          <span
            className={`h-6 w-11 rounded-full after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:bg-white after:content-[''] ${
              checked ? "bg-purple-600 after:translate-x-full after:border-white" : "bg-gray-600 after:border-gray-300"
            } ${dimmed ? "opacity-50" : ""}`}
          />
        </span>
        <span className={`min-w-0 text-sm ${dimmed ? "text-gray-400" : "text-gray-200"}`}>{label}</span>
        <span
          className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs font-bold ${
            checked ? "bg-purple-500/20 text-purple-100" : "bg-gray-700 text-gray-200"
          }`}
        >
          {stateText}
        </span>
      </div>
      <p className="-mt-0.5 ml-14 text-xs text-gray-400">{help}</p>
    </div>
  );
}
