"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { CARD_TRADE_UI_VISIBLE } from "@/lib/constants";

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
  // Whether this item requires supporter plan (support/patron)
  // この項目が支援者プラン（support/patron）を必要とするかどうか
  supporterOnly?: boolean;
  // Whether this item is only shown while the card-trade UI is publicly enabled
  // カードトレードUIが一般公開されている間だけ表示するかどうか
  requiresTradeUi?: boolean;
}

interface DashboardNavProps {
  // Whether the current user can use streamer features
  // 現在のユーザーが配信者機能を使用できるかどうか
  isStreamer: boolean;
  // Whether the current user has a supporter plan (support/patron)
  // 現在のユーザーが支援者プラン（support/patron）を持っているかどうか
  isSupporter: boolean;
}

/**
 * Dashboard navigation component
 * Displays sidebar navigation with conditional items based on user permissions
 * ダッシュボードナビゲーションコンポーネント
 * ユーザー権限に基づいて条件付き項目を含むサイドバーナビゲーションを表示
 */
export default function DashboardNav({ isStreamer, isSupporter }: DashboardNavProps) {
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
      href: "/dashboard/history",
      labelKey: "gachaHistory",
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
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      ),
    },
    {
      href: "/dashboard/stats",
      labelKey: "stats",
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
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
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
    {
      /*
       * #2078: トレードハブは視聴者も使う機能なので streamerOnly を付けない。
       * 一般公開前 (CARD_TRADE_UI_VISIBLE=false) は、既存のトレード入口と
       * 同じく項目ごと隠す。ただし /trade への直リンクは /trade/[streamerId]
       * と同じく到達できる（表示ゲートはサイドバーの入口だけに掛ける）。
       *
       * 「マイコレクション」の直後に置くのは、トレードがコレクションから
       * 発生する作業であり、#2079 のコレクション別一覧へ続く導線だから。
       */
      href: "/trade",
      labelKey: "trade",
      requiresTradeUi: true,
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
            d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
          />
        </svg>
      ),
    },
    {
      href: "/dashboard/inquiries",
      labelKey: "inquiries",
      supporterOnly: true,
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
            d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
          />
        </svg>
      ),
    },
    {
      // 公開ページへの導線は、ダッシュボード内の主要な作業フローとは分け、
      // 補助導線である「お問い合わせ」の隣へ置く。DOM順も表示順と揃えることで、
      // キーボード操作時にも同じ順序で移動できるようにする。
      href: "/live",
      labelKey: "live",
      icon: (
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="2" />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"
          />
        </svg>
      ),
    },
  ];

  // Filter navigation items based on user permissions
  // ユーザー権限に基づいてナビゲーション項目をフィルタリング
  // streamerOnly/supporterOnly/requiresTradeUi に基づいてフィルタリング
  const visibleNavItems = navItems.filter(
    (item) =>
      (!item.streamerOnly || isStreamer) &&
      (!item.supporterOnly || isSupporter) &&
      (!item.requiresTradeUi || CARD_TRADE_UI_VISIBLE)
  );

  /**
   * Check if a navigation item is currently active
   * Exact match for /dashboard, startsWith for other routes
   * Special case: /collection/* paths also activate the collection nav item
   * ナビゲーション項目が現在アクティブかどうかを確認
   * /dashboardは完全一致、その他のルートはstartsWithで判定
   * 特殊ケース: /collection/* パスもコレクションナビ項目をアクティブにする
   * /trade, /trade/[streamerId], /trade/mine は /trade の prefix 判定で
   * トレード項目だけが点灯する（コレクション項目は点灯しない）。
   */
  const isActive = (href: string) => {
    if (href === "/dashboard") {
      return pathname === "/dashboard";
    }
    // /collection/[streamerId] paths should also activate the collection nav item
    // /collection/[streamerId] パスでもコレクションナビ項目をアクティブにする
    if (href === "/dashboard/collection" && pathname.startsWith("/collection/")) {
      return true;
    }
    return pathname.startsWith(href);
  };

  return (
    /*
     * 項目は1回だけ描画する。以前はデスクトップ用の横並びとモバイル用の
     * 横スクロールを別々に描画しており、同じリンクが DOM に2つ存在していた。
     * 画面幅による表示の切り替えは DashboardShell 側のサイドバー / ドロワーが
     * 受け持つため、ここでは常に縦並びのリストだけを返す。
     *
     * aria-label はサイドバーというランドマークの名前になる。aria-current は
     * 「今いるページ」を支援技術へ伝えるためのもので、視覚的なハイライトだけに
     * 依存しない。
     */
    <nav
      aria-label={t("sidebarLabel")}
      className="rounded-xl bg-gray-800 p-2 lg:bg-transparent lg:p-0 lg:pr-4"
    >
      <ul className="flex flex-col gap-1">
        {visibleNavItems.map((item) => {
          const active = isActive(item.href);
          // デスクトップでは薄い紫の背景で現在地を示す。キーボードのフォーカスは
          // リンク全周の輪郭で示し、現在地と区別できるようにする。
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors lg:focus-visible:-outline-offset-2 lg:focus-visible:outline-2 lg:focus-visible:outline-purple-200 ${
                  active
                    ? "bg-purple-600 text-white lg:bg-purple-500/15 lg:text-purple-100"
                    : "text-gray-300 hover:bg-gray-700 hover:text-white lg:hover:bg-gray-800"
                }`}
              >
                {item.icon}
                <span>{t(item.labelKey)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
