import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getUnreadAnnouncements } from "@/lib/announcements";
import { getUserPlanSnapshot } from "@/lib/plan";
import { logPerf, perfStart } from "@/lib/perf";
import Header from "@/components/Header";
import DashboardNav from "@/components/DashboardNav";
import { TwitchLoginRedirect } from "@/components/TwitchLoginRedirect";

/**
 * Dashboard layout component
 * Provides shared layout for all dashboard pages including Header and Navigation
 * ダッシュボードレイアウトコンポーネント
 * HeaderとNavigationを含む全ダッシュボードページの共有レイアウトを提供
 *
 * Note: CSRF token is generated lazily on first POST request, not pre-generated here.
 * This improves page load performance by avoiding unnecessary crypto operations on GET.
 * CSRFトークンは最初のPOSTリクエスト時に遅延生成される（ここでは事前生成しない）。
 * GETリクエストでの不要な暗号化処理を避けることでページ読み込みパフォーマンスが向上。
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const startedAt = perfStart();
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

  // Check if user has a supporter plan (support/patron) for inquiry access
  // 問い合わせ機能アクセス用に支援者プランを確認
  const [plan, unreadAnnouncements] = await Promise.all([
    getUserPlanSnapshot(session.twitchUserId),
    getUnreadAnnouncements(session.twitchUserId),
  ]);
  const isSupporter = plan !== 'basic';
  const unreadAnnouncementsCount = unreadAnnouncements.length;
  logPerf("dashboard-layout", "load", startedAt, { isStreamer, isSupporter });

  return (
    <div className="min-h-screen bg-gray-900">
      <Header session={session} unreadAnnouncementsCount={unreadAnnouncementsCount} />

      <div className="container mx-auto px-4 py-6">
        {/* Navigation bar */}
        {/* ナビゲーションバー */}
        <div className="mb-6">
          <DashboardNav isStreamer={isStreamer} isSupporter={isSupporter} />
        </div>

        {/* Page content */}
        {/* ページコンテンツ */}
        <main>{children}</main>
      </div>
    </div>
  );
}
