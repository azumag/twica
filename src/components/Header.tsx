import Link from "next/link";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";

interface HeaderProps {
  session: Awaited<ReturnType<typeof getSession>>;
}

/**
 * Header Component (Server Component)
 * Displays navigation header with user info and icon buttons for settings/logout
 * ヘッダーコンポーネント（サーバーコンポーネント）- ユーザー情報と設定/ログアウトアイコンボタンを表示
 * モバイル対応: 1行レイアウトでアイコンボタンを使用してスペースを節約
 */
export default async function Header({ session }: HeaderProps) {
  const t = await getTranslations("header");
  if (!session) return null;

  const isStreamer = session.broadcasterType === "partner" || session.broadcasterType === "affiliate";

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
            {/* broadcaster type バッジ - PCのみ表示 */}
            {isStreamer && (
              <span className="hidden rounded bg-purple-600 px-2 py-0.5 text-xs text-white sm:inline">
                {session.broadcasterType}
              </span>
            )}
          </div>

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

          {/* ログアウトアイコン */}
          {/* API エンドポイントには Link ではなく通常の a タグを使用 */}
          <a
            href="/api/auth/logout"
            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
            title={t("logout")}
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
            <span className="sr-only">{t("logout")}</span>
          </a>
        </div>
      </div>
    </header>
  );
}