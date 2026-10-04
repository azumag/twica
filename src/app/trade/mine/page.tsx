import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { tradeLoginHref } from "@/lib/trade-client";
import MyTrades from "@/components/MyTrades";

/**
 * /trade/mine (§6.6). Login required; the list itself is fetched by
 * <MyTrades> from GET /api/trades/mine (paged per tab).
 *
 * This static segment takes precedence over /trade/[streamerId], so "mine"
 * is never interpreted as a streamer id.
 */
export default async function MyTradesPage() {
  const session = await getSession();
  if (!session) {
    redirect(tradeLoginHref("/trade/mine"));
  }
  const t = await getTranslations("trade");

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-bold text-white">{t("myTradesTitle")}</h1>
      <MyTrades />
    </div>
  );
}
