import { redirect } from "next/navigation";
import dynamic from "next/dynamic";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getStreamerData } from "@/lib/dashboard-data";
import { getUserPlan, PLAN_MAX_IMAGE_WIDTH, PLAN_AVAILABLE_WIDTHS } from "@/lib/plan";
import type { Card } from "@/types/database";

const CardManager = dynamic(() => import("@/components/CardManager"), {
  loading: () => (
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-6 text-sm text-gray-400">
      Loading cards...
    </div>
  ),
});

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

/**
 * Card management page for streamers
 * All cards are loaded server-side, with client-side sorting/filtering
 * 配信者向けカード管理ページ
 * 全カードはサーバーサイドで読み込み、クライアントサイドで並び替え/フィルタリング
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

  // Pass all cards from server (no pagination)
  // サーバーから全カードを渡す（ページネーションなし）
  const initialCards = streamerData.cards as Card[];

  // プランに応じた最大画像幅を取得
  const plan = await getUserPlan(session.twitchUserId);
  const maxImageWidth = PLAN_MAX_IMAGE_WIDTH[plan];
  const availableWidths = PLAN_AVAILABLE_WIDTHS[plan];

  return (
    <CardManager
      streamerId={streamerData.streamer.id}
      initialCards={initialCards}
      initialRarityWeights={streamerData.streamer.rarity_weights}
      initialCustomRarities={streamerData.streamer.custom_rarities ?? []}
      viewMode="list"
      showViewToggle={true}
      maxImageWidth={maxImageWidth}
      availableWidths={availableWidths}
    />
  );
}
