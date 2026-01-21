import { redirect } from "next/navigation";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData } from "@/lib/dashboard-data";
import CardManager from "@/components/CardManager";
import type { Card } from "@/types/database";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Card management page for streamers
 * Initial cards are loaded server-side, then client handles "Load More"
 * 配信者向けカード管理ページ
 * 初期カードはサーバーサイドで読み込み、その後クライアントで「もっと読み込む」を処理
 */
export default async function CardsPage() {
  const session = await getSession();

  // Session check is handled by layout, but double-check for safety
  // セッションチェックはレイアウトで行われるが、安全のため再確認
  if (!session) {
    redirect("/");
  }

  // Redirect non-streamers to main dashboard
  // 非配信者はメインダッシュボードにリダイレクト
  const isStreamer = canUseStreamerFeatures(session);
  if (!isStreamer) {
    redirect("/dashboard");
  }

  // Fetch streamer data (cards will be loaded via client-side API)
  // 配信者データを取得（カードはクライアントサイドAPIで読み込み）
  const streamerData = await getStreamerData(session.twitchUserId);

  if (!streamerData) {
    redirect("/dashboard");
  }

  // Pass initial cards (first 12) from server
  // サーバーから初期カード（最初の12件）を渡す
  const initialCards = streamerData.cards.slice(0, 12) as Card[];
  const totalCards = streamerData.cards.length;

  return (
    <CardManager
      streamerId={streamerData.streamer.id}
      initialCards={initialCards}
      totalCards={totalCards}
      viewMode="list"
      showViewToggle={true}
    />
  );
}
