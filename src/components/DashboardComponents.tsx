import { RARITY_COLORS, UI_STRINGS } from "@/lib/constants";
import Image from "next/image";

interface CardWithDetails {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  rarity: string;
  drop_rate: number;
  streamer: {
    twitch_display_name: string;
  };
  count: number;
}

interface GachaHistoryWithCard {
  id: string;
  user_twitch_username: string | null;
  cards: {
    name: string;
    rarity: string;
  };
  redeemed_at: string;
}

export function CardGrid({ cards }: { cards: CardWithDetails[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {cards.map((card) => (
        <div key={card.id} className="bg-white rounded-lg shadow-md p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-lg">{card.name}</h3>
            <span className={`px-2 py-1 rounded text-xs text-white ${RARITY_COLORS[card.rarity as keyof typeof RARITY_COLORS] || 'bg-gray-500'}`}>
              {card.rarity}
            </span>
          </div>
          {card.image_url && (
            <Image
              src={card.image_url}
              alt={card.name}
              width={200}
              height={200}
              className="w-full h-48 object-cover rounded mb-2"
            />
          )}
          {card.description && (
            <p className="text-sm text-gray-600 mb-2">{card.description}</p>
          )}
          <div className="flex justify-between text-sm text-gray-500">
            <span>{card.streamer.twitch_display_name}</span>
            <span>x{card.count}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function GachaHistoryList({ history }: { history: GachaHistoryWithCard[] }) {
  return (
    <div className="space-y-2">
      {history.map((entry) => (
        <div key={entry.id} className="bg-white rounded-lg shadow p-3 flex justify-between items-center">
          <div>
            <span className="font-medium">{entry.user_twitch_username || UI_STRINGS.GACHA_HISTORY.UNKNOWN}</span>
            <span className="text-gray-500">{UI_STRINGS.GACHA_HISTORY.GOT_LABEL}</span>
            <span className="font-semibold">{entry.cards.name}</span>
            <span className={`ml-2 px-2 py-1 rounded text-xs text-white ${RARITY_COLORS[entry.cards.rarity as keyof typeof RARITY_COLORS] || 'bg-gray-500'}`}>
              {entry.cards.rarity}
            </span>
          </div>
          <span className="text-sm text-gray-500">
            {new Date(entry.redeemed_at).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}