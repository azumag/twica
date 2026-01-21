import { redirect } from "next/navigation";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerDataPaginated } from "@/lib/dashboard-data";
import CardManager from "@/components/CardManager";
import type { Card } from "@/types/database";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

const CARDS_PER_PAGE = 8;

/**
 * Card management page for streamers with server-side pagination
 * サーバーサイドページング対応の配信者向けカード管理ページ
 */
export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
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

  // Get page from URL search params
  // URLパラメータからページ番号を取得
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10));

  // Fetch paginated streamer data
  // ページネーション対応の配信者データを取得
  const streamerData = await getStreamerDataPaginated(
    session.twitchUserId,
    page,
    CARDS_PER_PAGE
  );

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
      serverPagination={{
        currentPage: streamerData.pagination.page,
        totalPages: streamerData.pagination.totalPages,
        total: streamerData.pagination.total,
        perPage: streamerData.pagination.perPage,
      }}
    />
  );
}
