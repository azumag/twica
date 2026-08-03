import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getUnreadAnnouncements } from "@/lib/announcements";
import { getUserPlanSnapshot } from "@/lib/plan";
import { logPerf, perfStart } from "@/lib/perf";
import Header from "@/components/Header";
import DashboardNav from "@/components/DashboardNav";
import { TwitchLoginRedirect } from "@/components/TwitchLoginRedirect";
import { MaintenanceStatusProvider } from "@/components/MaintenanceStatusProvider";
import MaintenanceBanner from "@/components/MaintenanceBanner";
import ChatDeliveryWarning from "@/components/ChatDeliveryWarning";
import { getChatDeliveryCapability } from "@/lib/twitch/chat-delivery-capability";
import { ChatReauthorizationProvider } from "@/lib/twitch/use-chat-reauthorization";

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
  const [plan, unreadAnnouncements, chatDeliveryCapability] = await Promise.all([
    getUserPlanSnapshot(session.twitchUserId),
    getUnreadAnnouncements(session.twitchUserId),
    // 視聴者には配信設定がないためDB照会を行わない。配信者だけ、設定・
    // active Bot・DB保存scopeをページロード時に確認する。外部Twitch APIは呼ばず、
    // helperはReact cacheされているので、settings pageも同じ判定を要求しても
    // request内のI/Oは重複しない。
    isStreamer
      ? getChatDeliveryCapability(session.twitchUserId)
      : Promise.resolve(null),
  ]);
  const isSupporter = plan !== 'basic';
  const unreadAnnouncementsCount = unreadAnnouncements.length;
  logPerf("dashboard-layout", "load", startedAt, { isStreamer, isSupporter });

  return (
    // MaintenanceStatusProvider を Header 含めダッシュボード全体で共有する。
    // Header自体は書き込みを行わないが、Providerをこの階層に置くことで
    // ダッシュボード配下のどのページ・どのコンポーネントからも
    // useMaintenanceStatus() で同じ1系統のpolling結果を参照できる
    // （書き込みボタンごとの個別fetchを避ける設計。詳細は
    // MaintenanceStatusProvider.tsx のコメント参照）。
    <MaintenanceStatusProvider>
      {/* 共通警告とsettings内CTAでOAuth state発行を競合させないよう、
          dashboard全体を1つの再認証single-flight境界に置く。 */}
      <ChatReauthorizationProvider>
        <div className="min-h-screen bg-gray-900">
          <Header session={session} unreadAnnouncementsCount={unreadAnnouncementsCount} />

          <div className="container mx-auto px-4 py-6">
            {/* メンテナンスバナー: read-only中であることをダッシュボード全体で常時表示 */}
            <MaintenanceBanner />

            {/* チャット通知が有効なのに実効送信手段がない場合の非dismissable警告 */}
            <ChatDeliveryWarning needsAttention={chatDeliveryCapability?.needsAttention ?? false} />

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
      </ChatReauthorizationProvider>
    </MaintenanceStatusProvider>
  );
}
