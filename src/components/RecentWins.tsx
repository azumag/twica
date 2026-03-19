import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { RARITY_COLORS } from "@/lib/constants";

interface RecentGachaEntry {
  id: string;
  user_twitch_username: string | null;
  redeemed_at: string;
  cards: {
    name: string;
    image_url: string | null;
    rarity: string;
  };
}

interface RecentWinsProps {
  recentGacha: RecentGachaEntry[];
}

/**
 * Recent Wins Component (Server Component)
 * Displays recent gacha acquisitions
 * 最近の獲得コンポーネント（サーバーコンポーネント）- 最近のガチャ獲得を表示
 */
export default async function RecentWins({ recentGacha }: RecentWinsProps) {
  const t = await getTranslations("gachaHistory");
  return (
    <section className="mb-12">
      <h2 className="mb-6 text-2xl font-semibold text-white">{t("title")}</h2>
      <div className="overflow-hidden rounded-xl bg-gray-800">
        <div className="divide-y divide-gray-700">
          {recentGacha.length === 0 ? (
            <div className="p-6 text-center text-gray-400">
              {t("emptyMessage")}
            </div>
          ) : (
            recentGacha.map((entry) => (
              <div key={entry.id} className="flex items-center gap-4 p-4">
                <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-gray-700">
                  {entry.cards.image_url ? (
                    <Image
                      src={getOptimizedImageUrl(entry.cards.image_url, "icon")}
                      alt={entry.cards.name}
                      width={48}
                      height={48}
                      className="h-full w-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xl">
                      🎴
                    </div>
                  )}
                 </div>
                 <div className="flex-1 min-w-0">
                   <p className="text-sm font-medium text-white">
                     {t("got", { username: entry.user_twitch_username || t("unknown"), cardName: entry.cards.name })}
                   </p>
                  <p className="text-xs text-gray-500">
                    {new Date(entry.redeemed_at).toLocaleString('ja-JP')}
                  </p>
                </div>
                <div className={`rounded-full px-2 py-0.5 text-xs text-white ${RARITY_COLORS[entry.cards.rarity as keyof typeof RARITY_COLORS] || 'bg-gray-500'}`}>
                  {entry.cards.rarity}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}