import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getUnreadAnnouncements } from "@/lib/announcements";
import { getUserPlan } from "@/lib/plan";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { COLLECTION_CLIENT_NAMESPACES, pick } from "@/i18n/client-namespaces";
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
  // Nested provider は parent の messages を置換する。collection 配下の
  // client component（Header 内の client 部品、DashboardNav、collection pages）が
  // 必要とする namespace をこの provider で自己完結させる。
  const messages = await getMessages();

  // Redirect to login if not authenticated
  // 未認証の場合はログインページにリダイレクト
  if (!session) {
    // 早期 return も含めて provider 配下に置く。TwitchLoginRedirect が読む
    // auth / maintenance は collection の list に含まれている。
    return (
      <NextIntlClientProvider messages={pick(messages, COLLECTION_CLIENT_NAMESPACES)}>
        <TwitchLoginRedirect />
      </NextIntlClientProvider>
    );
  }

  // Check if user has streamer features (affiliate/partner)
  // ユーザーが配信者機能を持っているか確認（アフィリエイト/パートナー）
  const isStreamer = canUseStreamerFeatures(session);

  // Check if user has a supporter plan for inquiry nav item
  // 問い合わせナビ項目の表示用に支援者プランを確認
  const plan = await getUserPlan(session.twitchUserId);
  const isSupporter = plan !== 'basic';

  // Get unread announcements count for header badge
  // ヘッダーのバッジ表示用に未読お知らせ数を取得
  const unreadAnnouncements = await getUnreadAnnouncements(session.twitchUserId);
  const unreadAnnouncementsCount = unreadAnnouncements.length;

  return (
    // collection 配下の client component は root の list を継承できないため、
    // この layout で必要な namespace をすべて渡す。
    <NextIntlClientProvider messages={pick(messages, COLLECTION_CLIENT_NAMESPACES)}>
      <div className="min-h-screen bg-gray-900">
        <Header session={session} unreadAnnouncementsCount={unreadAnnouncementsCount} />

        <div className="container mx-auto px-4 py-6">
          {/* Navigation bar - same as dashboard, with collection item active */}
          {/* ナビゲーションバー - ダッシュボードと同じ、コレクション項目がアクティブ */}
          <div className="mb-6">
            <DashboardNav isStreamer={isStreamer} isSupporter={isSupporter} />
          </div>

          {/* Page content */}
          {/* ページコンテンツ */}
          <main>{children}</main>
        </div>
      </div>
    </NextIntlClientProvider>
  );
}
