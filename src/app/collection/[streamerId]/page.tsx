import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import {
  getUserCardsForStreamer,
  getStreamerById,
  getActiveCardsForStreamer,
  getCollectionCompletions,
  recordCollectionCompletion,
} from "@/lib/dashboard-data";
import StreamerCollection from "@/components/StreamerCollection";
import type { StreamerCollectionCard } from "@/components/StreamerCollection";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Streamer-specific collection page
 * Shows only the cards the user has collected from a specific streamer
 * 配信者別コレクションページ
 * ユーザーが特定の配信者から獲得したカードのみを表示
 */
export default async function StreamerCollectionPage({
  params,
}: {
  params: Promise<{ streamerId: string }>;
}) {
  const { streamerId } = await params;
  const session = await getSession();

  // If not logged in, redirect to login with return URL
  // 未ログインの場合、ログインページへリダイレクトし、ログイン後に戻る
  // Note: We pass returnTo as a query parameter since cookies cannot be set in Server Components
  // Server ComponentではCookieを設定できないため、クエリパラメータでreturnToを渡す
  if (!session) {
    const returnTo = encodeURIComponent(`/collection/${streamerId}`);
    redirect(`/api/auth/twitch/login?redirect=true&returnTo=${returnTo}`);
  }

  // Get streamer info
  // 配信者情報を取得
  const streamer = await getStreamerById(streamerId);
  if (!streamer) {
    notFound();
  }

  // Fetch user's cards, all active cards, and completion history in parallel
  // ユーザー所持カード・全アクティブカード・コンプリート履歴を並列取得
  const [userCards, activeCards, completionHistory] = await Promise.all([
    getUserCardsForStreamer(session.twitchUserId, streamerId),
    getActiveCardsForStreamer(streamerId),
    getCollectionCompletions(session.twitchUserId, streamerId),
  ]);

  // Build full card list (owned + unowned) based on active cards
  // アクティブカードを基準に、所持/未所持を統合した一覧を作成
  const ownedCardMap = new Map(userCards.map((card) => [card.id, card]));
  const cards: StreamerCollectionCard[] = activeCards.map((card) => {
    const ownedCard = ownedCardMap.get(card.id);
    return {
      ...card,
      count: ownedCard?.count || 0,
      isOwned: !!ownedCard,
    };
  });

  const ownedCards = cards.filter((card) => card.isOwned);

  // Calculate collection statistics
  // コレクション統計を計算
  const stats = {
    total: ownedCards.reduce((sum, c) => sum + c.count, 0),
    unique: ownedCards.length,
    legendary: ownedCards.filter((c) => c.rarity === "legendary").length,
    epic: ownedCards.filter((c) => c.rarity === "epic").length,
    rare: ownedCards.filter((c) => c.rarity === "rare").length,
    common: ownedCards.filter((c) => c.rarity === "common").length,
  };

  const progress = {
    owned: ownedCards.length,
    total: cards.length,
  };

  // コンプリート達成時、非ブロッキングでDBに記録
  // fire-and-forget: ページ表示をブロックしない
  if (progress.total > 0 && progress.owned >= progress.total) {
    void recordCollectionCompletion(session.twitchUserId, streamerId, progress.total);
  }

  return (
    <StreamerCollection
      streamer={streamer}
      cards={cards}
      stats={stats}
      progress={progress}
      completionHistory={completionHistory}
    />
  );
}
