import { getSession, canUseStreamerFeatures } from "@/lib/session";
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

  return (
    <div className="min-h-screen bg-gray-900">
      <Header session={session} />

      <div className="container mx-auto px-4 py-6">
        {/* Navigation bar */}
        {/* ナビゲーションバー */}
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
