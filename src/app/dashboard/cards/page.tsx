import { redirect } from "next/navigation";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData } from "@/lib/dashboard-data";
import CardManager from "@/components/CardManager";
import type { Card } from "@/types/database";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Card management page for streamers
 * Full card CRUD functionality with view toggle and pagination
 * 配信者向けカード管理ページ
 * 表示切り替えとページネーション付きのフルカードCRUD機能
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

  // Fetch streamer data including cards
  // カードを含む配信者データを取得
  const streamerData = await getStreamerData(session.twitchUserId);

  if (!streamerData) {
    redirect("/dashboard");
  }

  return (
    <CardManager
      streamerId={streamerData.streamer.id}
      initialCards={streamerData.cards as Card[]}
      viewMode="list"
      showViewToggle={true}
      enablePagination={true}
      cardsPerPage={12}
    />
  );
}
