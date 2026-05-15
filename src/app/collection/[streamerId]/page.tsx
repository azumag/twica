import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import {
  getUserCardsForStreamer,
  getStreamerById,
  getActiveCardsForStreamer,
  getCardStoneBalance,
  getCollectionCompletions,
  recordCollectionCompletion,
} from "@/lib/dashboard-data";
import {
  countOwnedActiveCardTypes,
  createCollectionNumberMap,
  sortCollectedCards,
} from "@/lib/collection-utils";
import StreamerCollection from "@/components/StreamerCollection";
import type { StreamerCollectionCard } from "@/components/StreamerCollection";
import type { Rarity } from "@/types/database";

// レアリティごとのカードストーン価値。
// IMPORTANT: SQL 側の `card_stone_value_for_rarity`
// (supabase/migrations/00040_add_card_stones_exchange.sql) と必ず同期させること。
// 実際の付与値はサーバ RPC が決定するため、ここはあくまで UI 表示用の見積もり値。
// MUST stay in sync with the SQL `card_stone_value_for_rarity` function.
const CARD_STONE_VALUES: Record<Rarity, number> = {
  common: 1,
  rare: 3,
  epic: 8,
  legendary: 20,
};

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
  const [userCards, activeCards, completionHistory, cardStoneBalance] = await Promise.all([
    getUserCardsForStreamer(session.twitchUserId, streamerId),
    getActiveCardsForStreamer(streamerId),
    getCollectionCompletions(session.twitchUserId, streamerId),
    getCardStoneBalance(session.twitchUserId, streamerId),
  ]);

  const activeCardIds = new Set(activeCards.map((card) => card.id));
  const collectionNumberMap = createCollectionNumberMap([...activeCards, ...userCards]);
  const ownedCards: StreamerCollectionCard[] = sortCollectedCards(userCards).map((card) => ({
    ...card,
    count: card.count,
    isOwned: true,
    collectionNumber: collectionNumberMap.get(card.id),
  }));

  // 未所持カードの視聴者向け表示（Issue #395）
  // Unowned-card visibility for viewers (Issue #395):
  //  - show_unowned_cards=false (default): viewer sees only owned cards (legacy behavior)
  //  - show_unowned_cards=true: viewer also sees unowned active cards (sorted by rarity, after owned)
  // 「未所持の詳細を隠す」表示制御は SortedCardGrid の props で行うため、ここではカード自体を含めるかだけを判定する。
  // The "hide details" toggle is enforced in SortedCardGrid; here we only decide inclusion.
  const ownedCardIds = new Set(ownedCards.map((card) => card.id));
  const unownedCards: StreamerCollectionCard[] = streamer.show_unowned_cards
    ? sortCollectedCards(
        activeCards.filter((card) => !ownedCardIds.has(card.id))
      ).map((card) => ({
        ...card,
        count: 0,
        isOwned: false,
        collectionNumber: collectionNumberMap.get(card.id),
      }))
    : [];

  // 所持カードを先頭に、未所持カードを後ろに連結
  // Owned cards first, unowned cards appended after — keeps "your collection" at the top.
  const cards: StreamerCollectionCard[] = [...ownedCards, ...unownedCards];

  // Calculate collection statistics — 未所持カードはカウントしない（所持実績のみ）
  // Stats summarize the viewer's actual ownership; unowned cards are excluded.
  const stats = {
    total: ownedCards.reduce((sum, c) => sum + c.count, 0),
    unique: ownedCards.length,
    legendary: ownedCards.filter((c) => c.rarity === "legendary").length,
    epic: ownedCards.filter((c) => c.rarity === "epic").length,
    rare: ownedCards.filter((c) => c.rarity === "rare").length,
    common: ownedCards.filter((c) => c.rarity === "common").length,
  };

  const progress = {
    owned: countOwnedActiveCardTypes(ownedCards, activeCardIds),
    total: activeCards.length,
  };
  const isCurrentComplete = progress.total > 0 && progress.owned >= progress.total;
  const hasCurrentCompletionRecord = completionHistory.some(
    (record) => record.total_cards === progress.total
  );
  const completionHistoryForDisplay = isCurrentComplete && !hasCurrentCompletionRecord
    ? [{ total_cards: progress.total, completed_at: new Date().toISOString() }, ...completionHistory]
    : completionHistory;
  const duplicateExchangeCards = ownedCards
    .filter((card) => card.count > 1)
    .map((card) => ({
      id: card.id,
      name: card.name,
      rarity: card.rarity,
      count: card.count,
      collectionNumber: card.collectionNumber,
      stoneValue: CARD_STONE_VALUES[card.rarity],
    }));

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
      // visibleCardTypes は「視聴者がページ上で見ている種類数」(所持 + 表示中の未所持)
      // visibleCardTypes is the number of card types the viewer sees on this page.
      visibleCardTypes={cards.length}
      completionHistory={completionHistoryForDisplay}
      cardStoneBalance={cardStoneBalance}
      duplicateExchangeCards={duplicateExchangeCards}
      // 未所持カードの画像/詳細を隠すかどうか（show_unowned_cards=false の場合は意味を持たない）
      hideUnownedDetails={!streamer.show_unowned_card_details}
    />
  );
}
