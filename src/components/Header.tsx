import Link from "next/link";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { LogoutButton } from "@/components/LogoutButton";

interface HeaderProps {
  session: Awaited<ReturnType<typeof getSession>>;
  unreadAnnouncementsCount?: number;
}

/**
 * Header Component (Server Component)
 * Displays navigation header with user info and icon buttons for settings/logout
 * ヘッダーコンポーネント（サーバーコンポーネント）- ユーザー情報と設定/ログアウトアイコンボタンを表示
 * モバイル対応: 1行レイアウトでアイコンボタンを使用してスペースを節約
 */
export default async function Header({ session, unreadAnnouncementsCount = 0 }: HeaderProps) {
  const t = await getTranslations("header");
  if (!session) return null;

  // #788: 非Affiliateユーザーが明示的にtwica配信者機能を有効化した場合もisStreamerに含める。
  // broadcasterTypeの直接比較ではなく、共通判定helperを使う（子E #793監査対象）。
  const isStreamer = canUseStreamerFeatures(session);

  return (
    <header className="border-b border-gray-800 bg-gray-900/95 backdrop-blur">
      <div className="container mx-auto flex items-center justify-between px-4 py-3">
        {/* ロゴ */}
        <Link href="/" className="text-xl font-bold text-white sm:text-2xl">
          TwiCa
        </Link>

        {/* 右側: ユーザー情報とアイコンボタン */}
        <div className="flex items-center gap-2 sm:gap-4">
          {/* ユーザー情報 */}
          <div className="flex items-center gap-2">
            {session.twitchProfileImageUrl && (
              // unoptimized: Twitch CDNから取得済みの画像のため、Vercel Image Transformationsをスキップしてコスト削減
              <Image
                src={session.twitchProfileImageUrl}
                alt={session.twitchDisplayName}
                width={28}
                height={28}
                className="h-7 w-7 rounded-full sm:h-8 sm:w-8"
                unoptimized
              />
            )}
            {/* モバイルでは名前を短縮表示、PCではフル表示 */}
            <span className="hidden text-white sm:inline">{session.twitchDisplayName}</span>
            <span className="max-w-[80px] truncate text-sm text-white sm:hidden">
              {session.twitchDisplayName}
            </span>
            {/* 配信者バッジ - PCのみ表示。broadcasterTypeが空(非Affiliateオプトイン)の
                場合に空文字を表示しないよう、常にi18n済みラベルを使う。 */}
            {isStreamer && (
              <span className="hidden rounded bg-purple-600 px-2 py-0.5 text-xs text-white sm:inline">
                {session.broadcasterType || t("streamerBadge")}
              </span>
            )}
          </div>

          {/* お知らせアイコン（ベル） - 未読がある場合はバッジ表示 */}
          <Link
            href="/dashboard/announcements"
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
            title={t("announcements")}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            {unreadAnnouncementsCount > 0 && (
              <span className="absolute right-0 top-0 z-10 flex h-5 min-w-5 translate-x-1/3 -translate-y-1/3 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold tabular-nums text-white ring-2 ring-gray-900">
                {unreadAnnouncementsCount > 99 ? "99+" : unreadAnnouncementsCount}
              </span>
            )}
            <span className="sr-only">{t("announcements")}</span>
          </Link>

          {/* ユーザー設定アイコン（歯車） - 言語設定などへ遷移 */}
          <Link
            href="/dashboard/account"
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
            title={t("userSettings")}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
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
            <span className="sr-only">{t("userSettings")}</span>
          </Link>

          {/* ログアウトボタン: 状態変更を GET で起動しないため POST する LogoutButton を使用 */}
          <LogoutButton
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white disabled:opacity-50"
            label={t("logout")}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
          </LogoutButton>
        </div>
      </div>
    </header>
  );
}
