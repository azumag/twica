"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Navigation item definition for dashboard sidebar
 * ダッシュボードサイドバーのナビゲーション項目定義
 */
interface NavItem {
  href: string;
  labelKey: string;
  // Icon component for the navigation item
  // ナビゲーション項目のアイコンコンポーネント
  icon: React.ReactNode;
  // Whether this item requires streamer features (affiliate/partner)
  // この項目が配信者機能を必要とするかどうか
  streamerOnly?: boolean;
}

interface DashboardNavProps {
  // Whether the current user can use streamer features
  // 現在のユーザーが配信者機能を使用できるかどうか
  isStreamer: boolean;
}

/**
 * Dashboard navigation component
 * Displays sidebar navigation with conditional items based on user permissions
 * ダッシュボードナビゲーションコンポーネント
 * ユーザー権限に基づいて条件付き項目を含むサイドバーナビゲーションを表示
 */
export default function DashboardNav({ isStreamer }: DashboardNavProps) {
  const pathname = usePathname();
  const t = useTranslations("navigation");

  // Navigation items configuration
  // ナビゲーション項目の設定
  const navItems: NavItem[] = [
    {
      href: "/dashboard",
      labelKey: "overview",
      icon: (
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
          />
        </svg>
      ),
    },
    {
      href: "/dashboard/cards",
      labelKey: "cardManagement",
      streamerOnly: true,
      icon: (
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
          />
        </svg>
      ),
    },
    {
      href: "/dashboard/settings",
      labelKey: "settings",
      streamerOnly: true,
      icon: (
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      ),
    },
    {
      href: "/dashboard/collection",
      labelKey: "collection",
      icon: (
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
          />
        </svg>
      ),
    },
  ];

  // Filter navigation items based on user permissions
  // ユーザー権限に基づいてナビゲーション項目をフィルタリング
  const visibleNavItems = navItems.filter(
    (item) => !item.streamerOnly || isStreamer
  );

  /**
   * Check if a navigation item is currently active
   * Exact match for /dashboard, startsWith for other routes
   * ナビゲーション項目が現在アクティブかどうかを確認
   * /dashboardは完全一致、その他のルートはstartsWithで判定
   */
  const isActive = (href: string) => {
    if (href === "/dashboard") {
      return pathname === "/dashboard";
    }
    return pathname.startsWith(href);
  };

  return (
    <nav className="bg-gray-800 rounded-xl p-2">
      {/* Desktop: Horizontal navigation bar / デスクトップ: 水平ナビゲーションバー */}
      <div className="hidden md:flex md:gap-1">
        {visibleNavItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              isActive(item.href)
                ? "bg-purple-600 text-white"
                : "text-gray-300 hover:bg-gray-700 hover:text-white"
            }`}
          >
            {item.icon}
            <span>{t(item.labelKey)}</span>
          </Link>
        ))}
      </div>

      {/* Mobile: Horizontal scrollable navigation with scroll indicator */}
      {/* モバイル: 水平スクロールナビゲーション + スクロールインジケーター */}
      <div className="relative md:hidden">
        <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-thin scrollbar-track-gray-700 scrollbar-thumb-gray-500">
          {visibleNavItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive(item.href)
                  ? "bg-purple-600 text-white"
                  : "text-gray-300 hover:bg-gray-700 hover:text-white"
              }`}
            >
              {item.icon}
              <span>{t(item.labelKey)}</span>
            </Link>
          ))}
          {/* 右端のスペーサー - スクロール可能であることを示すための余白 */}
          <div className="shrink-0 w-2" aria-hidden="true" />
        </div>
        {/* 右端にスクロール可能を示すグラデーションオーバーレイ */}
        <div
          className="pointer-events-none absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-gray-800 to-transparent"
          aria-hidden="true"
        />
      </div>
    </nav>
  );
}
