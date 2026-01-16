import Image from "next/image";

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

export default function RecentWins({ recentGacha }: RecentWinsProps) {
  return (
    <section className="mb-12">
      <h2 className="mb-6 text-2xl font-semibold text-white">最近の獲得情報</h2>
      <div className="overflow-hidden rounded-xl bg-gray-800">
        <div className="divide-y divide-gray-700">
          {recentGacha.length === 0 ? (
            <div className="p-6 text-center text-gray-400">
              まだ獲得情報はありません。
            </div>
          ) : (
            recentGacha.map((entry) => (
              <div key={entry.id} className="flex items-center gap-4 p-4">
                <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-gray-700">
                  {entry.cards.image_url ? (
                    <Image
                      src={entry.cards.image_url}
                      alt={entry.cards.name}
                      width={48}
                      height={48}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xl">
                      🎴
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white">
                    <span className="text-purple-400 font-bold">{entry.user_twitch_username || 'Unknown'}</span> が
                    <span className="text-white font-bold ml-1">{entry.cards.name}</span> を獲得しました！
                  </p>
                  <p className="text-xs text-gray-500">
                    {new Date(entry.redeemed_at).toLocaleString('ja-JP')}
                  </p>
                </div>
                <div className={`rounded-full px-2 py-0.5 text-xs text-white bg-yellow-500`}>
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