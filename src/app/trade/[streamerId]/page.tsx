import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { getStreamerById } from "@/lib/dashboard-data";
import { isCanonicalUuid } from "@/lib/uuid-validation";
import type { TradeScope } from "@/lib/trade";
import TradeBoard from "@/components/TradeBoard";

/**
 * トレードボード (#726, §6.3)。
 * 既存コレクションページと異なり、未ログインでも閲覧可
 * (アクションのみログイン誘導が本機能で確立する新パターン)。
 */
export default async function TradeBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ streamerId: string }>;
  searchParams: Promise<{ scope?: string }>;
}) {
  const { streamerId } = await params;
  const { scope: rawScope } = await searchParams;
  if (!isCanonicalUuid(streamerId)) {
    notFound();
  }

  const streamer = await getStreamerById(streamerId);
  if (!streamer) {
    notFound();
  }

  const t = await getTranslations("trade");
  const scope: TradeScope = rawScope === "cross" ? "cross_channel" : "in_channel";
  const tradeEnabled = streamer.trade_enabled ?? false;
  const crossEnabled = streamer.cross_channel_trade_enabled ?? false;

  return (
    <div className="min-h-screen bg-gray-900 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-4xl">
        <Link
          href={`/collection/${streamerId}`}
          className="text-sm text-purple-400 hover:text-purple-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        >
          ← {t("backToCollection")}
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-white">
          {t("boardTitle", { channelName: streamer.twitch_display_name })}
        </h1>
        {tradeEnabled ? (
          <div className="mt-4">
            <TradeBoard
              streamerId={streamerId}
              initialScope={scope === "cross_channel" && !crossEnabled ? "in_channel" : scope}
              crossChannelEnabled={crossEnabled}
            />
          </div>
        ) : (
          <div role="alert" className="mt-4 rounded-xl bg-gray-800 p-8 text-center">
            <p className="text-gray-300">{t("errorTradeDisabled")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
