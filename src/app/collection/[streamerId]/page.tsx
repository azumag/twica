import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import {
  getUserCardsForStreamer,
  getStreamerById,
  getActiveCardsForStreamer,
  getCollectionCompletions,
  recordCollectionCompletion,
  recordPackCompletion,
} from "@/lib/dashboard-data";
import {
  countOwnedActiveCardTypes,
  createCollectionNumberMap,
  sortCollectedCards,
} from "@/lib/collection-utils";
import {
  computePackProgress,
  deriveCollectionPackGroups,
} from "@/lib/collection-packs";
import StreamerCollection from "@/components/StreamerCollection";
import type { StreamerCollectionCard } from "@/components/StreamerCollection";
import { aggregateCustomRarities } from "@/lib/rarity";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * 「今達成しているのに達成レコードがまだ無い」場合に、表示用の履歴へ
 * 楽観的な達成エントリを合成する（挿入完了を待たずに達成日時を出すための
 * 既存パターンを、全体/パック別で共有できるよう関数化。Issue #557）。
 * Synthesize an optimistic "just completed" entry when the achievement isn't
 * persisted yet — shared by the overall and per-pack displays.
 */
function withOptimisticCompletion(
  history: { total_cards: number; completed_at: string }[],
  progress: { owned: number; total: number },
): { total_cards: number; completed_at: string }[] {
  const isComplete = progress.total > 0 && progress.owned >= progress.total;
  const hasRecord = history.some((record) => record.total_cards === progress.total);
  return isComplete && !hasRecord
    ? [{ total_cards: progress.total, completed_at: new Date().toISOString() }, ...history]
    : history;
}

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
  const customRarities = aggregateCustomRarities(ownedCards);

  const stats = {
    total: ownedCards.reduce((sum, c) => sum + c.count, 0),
    unique: ownedCards.length,
    legendary: ownedCards.filter((c) => c.rarity === "legendary").length,
    epic: ownedCards.filter((c) => c.rarity === "epic").length,
    rare: ownedCards.filter((c) => c.rarity === "rare").length,
    common: ownedCards.filter((c) => c.rarity === "common").length,
    customRarities,
  };

  // Issue #557: 履歴はパック次元 (collection_name) 付きで返るようになった。
  // 全体コンプリートの既存ロジックは collection_name IS NULL の行だけを見る
  // （デプロイ窓で列が無い間は全行が null にフォールバックするため従来同等）。
  const overallCompletionHistory = completionHistory
    .filter((record) => record.collection_name === null)
    .map(({ total_cards, completed_at }) => ({ total_cards, completed_at }));

  const progress = {
    owned: countOwnedActiveCardTypes(ownedCards, activeCardIds),
    total: activeCards.length,
  };
  const isCurrentComplete = progress.total > 0 && progress.owned >= progress.total;
  const completionHistoryForDisplay = withOptimisticCompletion(overallCompletionHistory, progress);

  // Issue #557: アクティブカードからパックグループを導出（カタログ順、
  // カタログ外の孤立名は末尾、未分類カードがあればデフォルトパックを先頭）。
  // デプロイ窓で card_pack_names / default_card_pack_name 列が無い間は
  // プロパティ自体が undefined になるため ?? でフォールバックする。
  const packGroups = deriveCollectionPackGroups(activeCards, streamer.card_pack_names ?? []);

  // 名前付きパックが1つも使われていない配信者では、パック機能を一切出さない
  // （フィルタUI非表示・パック別達成の記録もしない）。デフォルトパックのみの
  // 状態は全体コンプリートと情報として同一で、UIにも表示されない記録を書く
  // 意味がないため（YAGNI）。
  const hasNamedPacks = packGroups.some((group) => !group.isDefault);

  const packs = hasNamedPacks
    ? packGroups.map((group) => {
        const packProgress = computePackProgress(ownedCards, activeCards, group.key);
        const packHistory = completionHistory
          .filter((record) => record.collection_name === group.key)
          .map(({ total_cards, completed_at }) => ({ total_cards, completed_at }));
        return {
          key: group.key,
          // デフォルトパックの表示名は配信者のオーバーライド
          // (default_card_pack_name)。null はクライアント側で汎用ラベルに
          // フォールバックする。
          displayName: group.isDefault ? (streamer.default_card_pack_name ?? null) : group.key,
          progress: packProgress,
          completionHistory: withOptimisticCompletion(packHistory, packProgress),
          isComplete: packProgress.total > 0 && packProgress.owned >= packProgress.total,
          hasStoredRecord: packHistory.some(
            (record) => record.total_cards === packProgress.total
          ),
        };
      })
    : [];

  // コンプリート達成時にDBに記録（awaitしないとWorkers打ち切りで記録が失われる）
  // insert + 一意インデックス違反(23505)無視のため重複時はスキップされる。
  // パック別は取得済み履歴に同一達成が既にあれば書き込み自体を省略する
  // （毎表示のNパック分の冗長INSERTを避ける。省略判定が競合レースに負けても
  // 23505を握り潰すだけなので安全）。全体コンプリートは従来どおり達成中は
  // 常に記録を試みる（既存挙動の維持）。
  const recordTasks: Promise<void>[] = [];
  if (isCurrentComplete) {
    recordTasks.push(recordCollectionCompletion(session.twitchUserId, streamerId, progress.total));
  }
  for (const pack of packs) {
    if (pack.isComplete && !pack.hasStoredRecord) {
      recordTasks.push(
        recordPackCompletion(session.twitchUserId, streamerId, pack.progress.total, pack.key)
      );
    }
  }
  if (recordTasks.length > 0) {
    await Promise.all(recordTasks);
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
      // 未所持カードの画像/詳細を隠すかどうか（show_unowned_cards=false の場合は意味を持たない）
      hideUnownedDetails={!streamer.show_unowned_card_details}
      // Issue #557: パック絞り込みタブ。isComplete/hasStoredRecord は記録判定用の
      // サーバー内部値なのでUIへは渡さない。
      packs={packs.map(({ key, displayName, progress: packProgress, completionHistory: packCompletionHistory }) => ({
        key,
        displayName,
        progress: packProgress,
        completionHistory: packCompletionHistory,
      }))}
    />
  );
}
