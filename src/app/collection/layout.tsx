import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getUnreadAnnouncements } from "@/lib/announcements";
import Header from "@/components/Header";
import DashboardNav from "@/components/DashboardNav";
import { TwitchLoginRedirect } from "@/components/TwitchLoginRedirect";

/**
 * Collection layout component
 * Provides shared layout for streamer-specific collection pages
 * Uses the same navigation bar as dashboard with "My Collection" highlighted
 * コレクションレイアウトコンポーネント
 * 配信者別コレクションページの共有レイアウトを提供
 * ダッシュボードと同じナビゲーションバーを使用し、「マイコレクション」がハイライトされる
 */
export default async function CollectionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Get session for authentication check
  // 認証確認のためにセッションを取得
  const session = await getSession();

  // Redirect to login if not authenticated
  // 未認証の場合はログインページにリダイレクト
  if (!session) {
    return <TwitchLoginRedirect />;
  }

  // Check if user has streamer features (affiliate/partner)
  // ユーザーが配信者機能を持っているか確認（アフィリエイト/パートナー）
  const isStreamer = canUseStreamerFeatures(session);

  // Get unread announcements count for header badge
  // ヘッダーのバッジ表示用に未読お知らせ数を取得
  const unreadAnnouncements = await getUnreadAnnouncements(session.twitchUserId);
  const unreadAnnouncementsCount = unreadAnnouncements.length;

  return (
    <div className="min-h-screen bg-gray-900">
      <Header session={session} unreadAnnouncementsCount={unreadAnnouncementsCount} />

      <div className="container mx-auto px-4 py-6">
        {/* Navigation bar - same as dashboard, with collection item active */}
        {/* ナビゲーションバー - ダッシュボードと同じ、コレクション項目がアクティブ */}
        <div className="mb-6">
          <DashboardNav isStreamer={isStreamer} />
        </div>

        {/* Page content */}
        {/* ページコンテンツ */}
        <main>{children}</main>
      </div>
    </div>
  );
}
