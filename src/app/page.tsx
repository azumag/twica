import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { TwitchLoginButtonWithIcon } from "@/components/TwitchLoginButton";
import TopPageHeader from "@/components/TopPageHeader";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

// searchParams型定義 - URLクエリパラメータを受け取るため
type SearchParams = Promise<{ error?: string }>;

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const session = await getSession();
  const t = await getTranslations("topPage");
  const tFooter = await getTranslations("footer");

  // URLのerrorパラメータを取得（認証エラー等のリダイレクト時に使用）
  const { error } = await searchParams;

  // Prepare session data for client component (without sensitive info)
  const sessionData = session ? {
    twitchUserId: session.twitchUserId,
    twitchUsername: session.twitchUsername,
    twitchDisplayName: session.twitchDisplayName,
    twitchProfileImageUrl: session.twitchProfileImageUrl,
    broadcasterType: session.broadcasterType,
  } : null;

  return (
    // overflow-x-hidden: モバイルで横スクロールを防止
    <div className="min-h-screen overflow-x-hidden bg-gray-900">
      {/* エラーメッセージ表示 - 認証エラー等でリダイレクトされた場合に表示 */}
      {error && (
        <div className="bg-red-900/50 border-b border-red-700">
          <div className="container mx-auto px-4 py-3">
            <p className="text-center text-sm text-red-200">{error}</p>
          </div>
        </div>
      )}
      <header className="border-b border-gray-800">
        <div className="container mx-auto px-4 py-4">
          <nav className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-white">TwiCa</h1>
            <TopPageHeader initialSession={sessionData} />
          </nav>
        </div>
      </header>

      <main className="container mx-auto px-4 py-16">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="mb-6 text-4xl font-bold text-white">
            {t("hero.twitchIntegration")}
            <br />
            <span className="text-purple-400">
              {t("hero.cardCollection")}
            </span>
          </h2>
          {/*
            スマホ: description1a/1b/2/3a/3b/4を各行で表示（自然な日本語の区切りで改行）
            PC: 1a+1b+2を1行目、3a+3b+4を2行目に表示
          */}
          <p className="mb-12 break-words text-lg text-gray-400">
            {t("hero.description1a")}
            <br className="sm:hidden" />
            {t("hero.description1b")}
            <br className="sm:hidden" />
            {t("hero.description2")}
            <br />
            {t("hero.description3a")}
            <br className="sm:hidden" />
            {t("hero.description3b")}
            <br className="sm:hidden" />
            {t("hero.description4")}
          </p>

          {/* ログイン状態に応じて表示を切り替え */}
          {session ? (
            // ログイン済み: 視聴者/配信者向けガイドへのリンクボタンを中央に表示
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
              <Link
                href="/guide#viewer"
                className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-8 py-3 font-medium text-white transition hover:bg-purple-700"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                {t("hero.viewerGuide")}
              </Link>
              <Link
                href="/guide#streamer"
                className="inline-flex items-center gap-2 rounded-lg border border-purple-600 bg-transparent px-8 py-3 font-medium text-purple-400 transition hover:bg-purple-600 hover:text-white"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                {t("hero.streamerGuide")}
              </Link>
            </div>
          ) : (
            // 未ログイン: Twitchログインボタンと使い方リンクを表示
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
              <TwitchLoginButtonWithIcon
                className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-8 py-3 font-medium text-white transition hover:bg-purple-700 disabled:opacity-50"
              />
              <Link
                href="/guide"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-600 px-8 py-3 font-medium text-gray-300 transition hover:bg-gray-800 hover:text-white"
              >
                {t("hero.viewGuide")}
              </Link>
            </div>
          )}
        </div>

        <div className="mt-20 grid gap-6 md:grid-cols-2">
          <div className="rounded-xl bg-gray-800 p-6">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-purple-600">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-semibold text-white">{t("features.cardCollection.title")}</h3>
            <p className="text-sm text-gray-400">
              {t("features.cardCollection.description")}
            </p>
          </div>
          <div className="rounded-xl bg-gray-800 p-6">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-purple-600">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-semibold text-white">{t("features.streamIntegration.title")}</h3>
            <p className="text-sm text-gray-400">
              {t("features.streamIntegration.description")}
            </p>
          </div>
        </div>

        {/* Info for streamers */}
        <div className="mx-auto mt-16 max-w-2xl rounded-xl bg-gray-800 p-6">
          <h3 className="mb-3 text-lg font-semibold text-white">{t("streamerInfo.title")}</h3>
          <p className="text-sm text-gray-400">
            {t("streamerInfo.description")}
          </p>
          <ul className="mt-3 space-y-1 text-sm text-gray-400">
            <li className="flex items-center gap-2">
              <span className="text-purple-400">•</span>
              {t("streamerInfo.feature1")}
            </li>
            <li className="flex items-center gap-2">
              <span className="text-purple-400">•</span>
              {t("streamerInfo.feature2")}
            </li>
            <li className="flex items-center gap-2">
              <span className="text-purple-400">•</span>
              {t("streamerInfo.feature3")}
            </li>
          </ul>
        </div>
      </main>

      <footer className="border-t border-gray-800">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="text-sm text-gray-500">&copy; 2025 TwiCa</p>
            <div className="flex flex-wrap justify-center gap-6">
              <Link href="/guide" className="text-sm text-gray-500 hover:text-gray-300">
                {tFooter("guide")}
              </Link>
              <Link href="/faq" className="text-sm text-gray-500 hover:text-gray-300">
                {tFooter("faq")}
              </Link>
              <Link href="/tos" className="text-sm text-gray-500 hover:text-gray-300">
                {tFooter("tos")}
              </Link>
              <Link href="/about" className="text-sm text-gray-500 hover:text-gray-300">
                {tFooter("about")}
              </Link>
              <Link href="/privacy" className="text-sm text-gray-500 hover:text-gray-300">
                {tFooter("privacy")}
              </Link>
              <Link href="/releases" className="text-sm text-gray-500 hover:text-gray-300">
                {tFooter("releaseNotes")}
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
