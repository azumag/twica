import type { Metadata } from "next";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getUnreadAnnouncements } from "@/lib/announcements";
import { getUserPlan } from "@/lib/plan";
import { pick, TRADE_CLIENT_NAMESPACES } from "@/i18n/client-namespaces";
import Header from "@/components/Header";
import DashboardNav from "@/components/DashboardNav";
import DashboardShell from "@/components/DashboardShell";
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
 *   - logged in  → same Header + DashboardShell (DashboardNav) as the dashboard, plus the
 *     maintenance provider/banner because trade pages perform writes;
 *   - anonymous  → minimal public header (Header renders nothing without a
 *     session) and the public footer.
 * The login-required pages are the hub (/trade) and the unified listing flow
 * (/trade/new); they redirect themselves with a returnTo, like
 * /collection/[streamerId]. The per-channel board and auction detail
 * (/trade/[streamerId] and below) stay readable anonymously.
 *
 * The pages put the guide link with their heading or back link so it remains
 * available on public boards and does not introduce a separate row above
 * the title when moving from the dashboard to trade.
 */
export default async function TradeLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  // Nested provider は parent の messages を置換する。匿名/ログインどちらの
  // branch にも client component（TradeBoard など）がいるため、両方の返り値を
  // 同じ list の provider で包み、root の list に依存させない。
  const messages = await getMessages();

  if (!session) {
    return (
      <NextIntlClientProvider messages={pick(messages, TRADE_CLIENT_NAMESPACES)}>
        <div className="min-h-screen bg-gray-900">
          <header className="border-b border-gray-800">
            <div className="container mx-auto px-4 py-4">
              <Link href="/" className="text-xl font-bold text-white">
                TwiCa
              </Link>
            </div>
          </header>
          <main className="container mx-auto px-4 py-6">
            <div className="mx-auto max-w-4xl">{children}</div>
          </main>
          <PublicFooter />
        </div>
      </NextIntlClientProvider>
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
    // The trade provider must also wrap this branch: the nested provider
    // replaces the root messages, so without it the logged-in trade pages would
    // lose `trade` / `navigation` / `maintenance` while rendering.
    <NextIntlClientProvider messages={pick(messages, TRADE_CLIENT_NAMESPACES)}>
      <MaintenanceStatusProvider>
        <div className="min-h-screen bg-gray-900">
          <Header session={session} unreadAnnouncementsCount={unreadAnnouncements.length} />
          <div className="dashboard-container py-4 sm:py-6">
            <MaintenanceBanner />
            <DashboardShell
              nav={<DashboardNav isStreamer={isStreamer} isSupporter={plan !== "basic"} />}
            >
              {/* Use the same left edge and available width as other signed-in pages. */}
              <main>{children}</main>
            </DashboardShell>
          </div>
        </div>
      </MaintenanceStatusProvider>
    </NextIntlClientProvider>
  );
}
