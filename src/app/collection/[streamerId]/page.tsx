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

  // Build owned-only card list in active card order
  // アクティブカード順を維持しつつ、所持カードのみを一覧化
  const ownedCardMap = new Map(userCards.map((card) => [card.id, card]));
  const cards: StreamerCollectionCard[] = activeCards.flatMap((card) => {
    const ownedCard = ownedCardMap.get(card.id);
    if (!ownedCard) return [];

    return [{
      ...card,
      count: ownedCard.count,
      isOwned: true,
    }];
  });

  // Calculate collection statistics
  // コレクション統計を計算
  const stats = {
    total: cards.reduce((sum, c) => sum + c.count, 0),
    unique: cards.length,
    legendary: cards.filter((c) => c.rarity === "legendary").length,
    epic: cards.filter((c) => c.rarity === "epic").length,
    rare: cards.filter((c) => c.rarity === "rare").length,
    common: cards.filter((c) => c.rarity === "common").length,
  };

  const progress = {
    owned: cards.length,
    total: activeCards.length,
  };
  const isCurrentComplete = progress.total > 0 && progress.owned >= progress.total;
  const hasCurrentCompletionRecord = completionHistory.some(
    (record) => record.total_cards === progress.total
  );
  const completionHistoryForDisplay = isCurrentComplete && !hasCurrentCompletionRecord
    ? [{ total_cards: progress.total, completed_at: new Date().toISOString() }, ...completionHistory]
    : completionHistory;

  // コンプリート達成時にDBに記録（awaitしないとWorkers打ち切りで記録が失われる）
  // upsert + ignoreDuplicates で高速、重複時はスキップされる
  if (isCurrentComplete) {
    await recordCollectionCompletion(session.twitchUserId, streamerId, progress.total);
  }

  return (
    <StreamerCollection
      streamer={streamer}
      cards={cards}
      stats={stats}
      progress={progress}
      completionHistory={completionHistoryForDisplay}
    />
  );
}
