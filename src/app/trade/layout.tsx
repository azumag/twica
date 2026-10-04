import type { Metadata } from "next";
import Link from "next/link";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getUnreadAnnouncements } from "@/lib/announcements";
import { getUserPlan } from "@/lib/plan";
import Header from "@/components/Header";
import DashboardNav from "@/components/DashboardNav";
import PublicFooter from "@/components/PublicFooter";
import { MaintenanceStatusProvider } from "@/components/MaintenanceStatusProvider";
import MaintenanceBanner from "@/components/MaintenanceBanner";

/**
 * Trade pages are per-user / per-moment listings (and the board is readable
 * without login), so none of them should be indexed by search engines (§6).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * Layout for /trade/** (#726/#727).
 *
 * Unlike /collection/layout.tsx this layout does NOT redirect anonymous
 * visitors: the trade board must be readable without login, with only the
 * actions (accept / create) leading to login. This is a new pattern in this
 * app ("browse public, act after login"), modelled on /live:
 *   - logged in  → same Header + DashboardNav as the dashboard, plus the
 *     maintenance provider/banner because trade pages perform writes;
 *   - anonymous  → minimal public header (Header renders nothing without a
 *     session) and the public footer.
 * Pages that require login (/trade/mine, the listing flow) redirect
 * themselves with a returnTo, like /collection/[streamerId].
 */
export default async function TradeLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) {
    return (
      <div className="min-h-screen bg-gray-900">
        <header className="border-b border-gray-800">
          <div className="container mx-auto px-4 py-4">
            <Link href="/" className="text-xl font-bold text-white">
              TwiCa
            </Link>
          </div>
        </header>
        <main className="container mx-auto px-4 py-6">{children}</main>
        <PublicFooter />
      </div>
    );
  }

  const isStreamer = canUseStreamerFeatures(session);
  const [plan, unreadAnnouncements] = await Promise.all([
    getUserPlan(session.twitchUserId),
    getUnreadAnnouncements(session.twitchUserId),
  ]);

  return (
    // Same single polling source as the dashboard: write buttons on trade
    // pages read the maintenance mode through useMaintenanceStatus().
    <MaintenanceStatusProvider>
      <div className="min-h-screen bg-gray-900">
        <Header session={session} unreadAnnouncementsCount={unreadAnnouncements.length} />
        <div className="container mx-auto px-4 py-6">
          <MaintenanceBanner />
          <div className="mb-6">
            <DashboardNav isStreamer={isStreamer} isSupporter={plan !== "basic"} />
          </div>
          <main>{children}</main>
        </div>
      </div>
    </MaintenanceStatusProvider>
  );
}
