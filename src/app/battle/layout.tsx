import { getSession } from "@/lib/session";
import { getUnreadAnnouncements } from "@/lib/announcements";
import Header from "@/components/Header";
import { TwitchLoginRedirect } from "@/components/TwitchLoginRedirect";
import { MaintenanceStatusProvider } from "@/components/MaintenanceStatusProvider";

/**
 * Battle layout component
 * Provides shared layout for battle pages with Header
 * バトルレイアウトコンポーネント
 * Headerを含むバトルページの共有レイアウトを提供
 */
export default async function BattleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session) {
    return <TwitchLoginRedirect />;
  }

  // Get unread announcements count for header badge
  // ヘッダーのバッジ表示用に未読お知らせ数を取得
  const unreadAnnouncements = await getUnreadAnnouncements(session.twitchUserId);
  const unreadAnnouncementsCount = unreadAnnouncements.length;

  return (
    // MaintenanceStatusProvider をバトルページ全体で共有する。
    // これによりstartBattleボタン等がuseMaintenanceStatus()経由で
    // 一元的なmaintenance状態（60秒ポーリング）を参照できる（#785）。
    <MaintenanceStatusProvider>
      <div className="min-h-screen bg-gray-900">
        <Header session={session} unreadAnnouncementsCount={unreadAnnouncementsCount} />
        {children}
      </div>
    </MaintenanceStatusProvider>
  );
}
