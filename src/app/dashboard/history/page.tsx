import { getTranslations } from "next-intl/server";
import dynamic from "next/dynamic";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerIdByTwitchUserId } from "@/lib/user-data";
import {
  getGachaHistoryForStreamer,
  getGachaHistoryForUser,
  getActiveCardsForStreamer,
} from "@/lib/dashboard-data";

const GachaHistoryTable = dynamic(() => import("@/components/GachaHistoryTable"), {
  loading: () => (
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-6 text-sm text-gray-400">
      Loading history...
    </div>
  ),
});

/**
 * Gacha History page
 * Streamer: shows all channel gacha history with filters
 * Viewer: shows their own gacha history
 * ガチャ履歴ページ
 * 配信者: フィルタ付きのチャネル全ガチャ履歴
 * 視聴者: 自分のガチャ履歴
 */
export default async function GachaHistoryPage() {
  const t = await getTranslations("gachaHistoryPage");
  const session = await getSession();

  if (!session) {
    return null;
  }

  const isStreamer = canUseStreamerFeatures(session);

  if (isStreamer) {
    // Get streamer_id for the current user
    // 現在のユーザーのstreamer_idを取得
    // #711: user-data.ts の getStreamerIdByTwitchUserId に委譲
    // （isPgReadEnabled() による経路分岐は関数内部で行われるため、このページは
    // フラグを意識しない）。
    const streamer = await getStreamerIdByTwitchUserId(session.twitchUserId);

    if (!streamer) {
      return null;
    }

    // Fetch history and active cards in parallel
    // 履歴とアクティブカードを並列取得
    const [result, activeCards] = await Promise.all([
      getGachaHistoryForStreamer(streamer.id),
      getActiveCardsForStreamer(streamer.id),
    ]);

    // Card list for filter dropdown (id + name only)
    // フィルタドロップダウン用のカード一覧（idとnameのみ）
    const cardOptions = activeCards.map((c) => ({ id: c.id, name: c.name }));

    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold text-white">{t("title")}</h1>
        <p className="mb-4 text-sm text-gray-400">{t("streamerDescription")}</p>
        <GachaHistoryTable
          initialHistory={result.history}
          initialPagination={result.pagination}
          isStreamer={true}
          cards={cardOptions}
          totalActiveCards={activeCards.length}
        />
      </div>
    );
  } else {
    // Viewer: show their own history
    // 視聴者: 自分の履歴を表示
    const result = await getGachaHistoryForUser(session.twitchUserId);

    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold text-white">{t("title")}</h1>
        <p className="mb-4 text-sm text-gray-400">{t("viewerDescription")}</p>
        <GachaHistoryTable
          initialHistory={result.history}
          initialPagination={result.pagination}
          isStreamer={false}
        />
      </div>
    );
  }
}
