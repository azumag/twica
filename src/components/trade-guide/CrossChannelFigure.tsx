import CardTile from "./CardTile";
import GuideIcon from "./GuideIcon";

type CrossChannelFigureProps = {
  inChannelTab: string;
  inChannelCaption: string;
  crossTab: string;
  crossCaption: string;
  streamerA: string;
  streamerB: string;
  sideA: string;
  sideB: string;
  condition: string;
};

/** Round "channel" avatar. A neutral person glyph: no streamer data is shown. */
function Streamer({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-200 ring-2 ring-purple-400/60">
        <GuideIcon name="user" className="h-6 w-6" />
      </span>
      <span className="text-sm font-semibold text-white">{name}</span>
    </div>
  );
}

function SwapBadge() {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-600 text-white">
      <GuideIcon name="swap" className="h-5 w-5" />
    </span>
  );
}

/**
 * Side-by-side "in-channel" vs "cross-channel" diagram. The tab names are the real
 * board tab labels (and use the same pill look as the board's tab strip), so the
 * reader can map the picture straight onto the screen.
 */
export default function CrossChannelFigure({
  inChannelTab,
  inChannelCaption,
  crossTab,
  crossCaption,
  streamerA,
  streamerB,
  sideA,
  sideB,
  condition,
}: CrossChannelFigureProps) {
  return (
    <figure className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl bg-gray-800 p-4">
          <p className="inline-block rounded-lg bg-purple-600 px-4 py-1.5 text-sm text-white">{inChannelTab}</p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <CardTile tone="give" label="" small />
            <SwapBadge />
            <CardTile tone="want" label="" small />
          </div>
          <div className="mt-3 flex justify-center">
            <Streamer name={streamerA} />
          </div>
          <p className="mt-3 text-center text-sm text-gray-300">{inChannelCaption}</p>
        </div>

        <div className="rounded-xl bg-gray-800 p-4">
          <p className="inline-block rounded-lg bg-purple-600 px-4 py-1.5 text-sm text-white">{crossTab}</p>
          <div className="mt-4 flex items-start justify-center gap-2 sm:gap-3">
            <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
              <CardTile tone="give" label="" small />
              <Streamer name={streamerA} />
              <p className="text-center text-xs text-gray-300">{sideA}</p>
            </div>
            <div className="self-start pt-8">
              <SwapBadge />
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
              <CardTile tone="want" label="" small />
              <Streamer name={streamerB} />
              <p className="text-center text-xs text-gray-300">{sideB}</p>
            </div>
          </div>
          <p className="mt-3 text-center text-sm text-gray-300">{crossCaption}</p>
        </div>
      </div>
      <figcaption className="flex items-start gap-2 rounded-xl border border-purple-500/40 bg-purple-900/20 p-3 text-sm text-purple-100">
        <GuideIcon name="check" className="mt-0.5 h-5 w-5 text-purple-300" />
        <span>{condition}</span>
      </figcaption>
    </figure>
  );
}
