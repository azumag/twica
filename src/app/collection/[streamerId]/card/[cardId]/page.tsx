import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { getUserCardDetail, getStreamerById } from "@/lib/dashboard-data";
import CardDetail from "@/components/CardDetail";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Card detail page - shows detailed information about a specific card
 * カード詳細ページ - 特定のカードの詳細情報を表示
 *
 * Displays:
 * - Card image (full size, no cropping for portrait images)
 * - Card name
 * - Card description
 * - Number of copies owned
 * - Rarity badge
 */
export default async function CardDetailPage({
  params,
}: {
  params: Promise<{ streamerId: string; cardId: string }>;
}) {
  const { streamerId, cardId } = await params;
  const session = await getSession();

  // If not logged in, redirect to login with return URL
  // 未ログインの場合、ログインページへリダイレクトし、ログイン後に戻る
  if (!session) {
    const returnTo = encodeURIComponent(`/collection/${streamerId}/card/${cardId}`);
    redirect(`/api/auth/twitch/login?redirect=true&returnTo=${returnTo}`);
  }

  // Get streamer info
  // 配信者情報を取得
  const streamer = await getStreamerById(streamerId);
  if (!streamer) {
    notFound();
  }

  // Get the specific card with user's ownership count
  // 特定のカードとユーザーの所有枚数を取得
  const card = await getUserCardDetail(session.twitchUserId, streamerId, cardId);

  // If user doesn't own this card, show 404
  // ユーザーがこのカードを所有していない場合は404を表示
  if (!card) {
    notFound();
  }

  return <CardDetail card={card} streamer={streamer} />;
}
