import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { getUserCardsForStreamer, getStreamerById } from "@/lib/dashboard-data";
import { RARITY_ORDER } from "@/lib/constants";
import StreamerCollection from "@/components/StreamerCollection";

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

  // Fetch user's card collection for this streamer
  // このユーザーがこの配信者から獲得したカードを取得
  const userCards = await getUserCardsForStreamer(session.twitchUserId, streamerId);

  // Sort cards by rarity (legendary first)
  // レアリティでソート（レジェンダリーが先頭）
  userCards.sort((a, b) => {
    return RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
  });

  // Calculate collection statistics
  // コレクション統計を計算
  const stats = {
    total: userCards.reduce((sum, c) => sum + c.count, 0),
    unique: userCards.length,
    legendary: userCards.filter((c) => c.rarity === "legendary").length,
    epic: userCards.filter((c) => c.rarity === "epic").length,
    rare: userCards.filter((c) => c.rarity === "rare").length,
    common: userCards.filter((c) => c.rarity === "common").length,
  };

  return <StreamerCollection streamer={streamer} cards={userCards} stats={stats} />;
}
