import { redirect } from "next/navigation";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData } from "@/lib/dashboard-data";
import CardManager from "@/components/CardManager";
import { UI_STRINGS } from "@/lib/constants";
import type { Card } from "@/types/database";

export const dynamic = "force-dynamic";

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
    <div>
      {/* Page header */}
      {/* ページヘッダー */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">
          {UI_STRINGS.CARDS_PAGE.TITLE}
        </h1>
        <p className="mt-2 text-gray-400">
          {UI_STRINGS.CARDS_PAGE.DESCRIPTION}
        </p>
      </div>

      {/* Card manager with full features */}
      {/* フル機能のカードマネージャー */}
      <CardManager
        streamerId={streamerData.streamer.id}
        initialCards={streamerData.cards as Card[]}
        showViewToggle={true}
        enablePagination={true}
        cardsPerPage={12}
      />
    </div>
  );
}
