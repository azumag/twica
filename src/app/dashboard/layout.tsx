import { getSession, canUseStreamerFeatures } from "@/lib/session";
import Header from "@/components/Header";
import DashboardNav from "@/components/DashboardNav";
import { TwitchLoginRedirect } from "@/components/TwitchLoginRedirect";
import { setCSRFToken } from "@/lib/csrf";

/**
 * Dashboard layout component
 * Provides shared layout for all dashboard pages including Header and Navigation
 * ダッシュボードレイアウトコンポーネント
 * HeaderとNavigationを含む全ダッシュボードページの共有レイアウトを提供
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

  // Pre-generate CSRF token for form submissions
  // フォーム送信用にCSRFトークンを事前生成
  try {
    await setCSRFToken();
  } catch {
    // Ignore errors - token will be generated lazily if needed
    // エラーは無視 - 必要に応じてトークンは遅延生成される
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
