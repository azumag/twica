import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import PublicFooter from "@/components/PublicFooter";

export const metadata: Metadata = {
  title: "Usage Ideas - TwiCa",
  description: "Fun ways to use TwiCa cards, from topic decks to fan art.",
};

// 各要素はメッセージ側の usagesPage.<key> と1対1で対応し、配列の順序が表示順。
// カードのグリッド描画を1箇所に集約するため、ユースケースを増やすときは
// この配列とメッセージの両方を更新する必要があり、
// tests/unit/public-help-pages.test.ts の同期テストが両者の一致を強制する。
const usages = [
  "topicDeck",
  "foodDiary",
  "acquaintanceStreamers",
  "quoteCards",
  "fanArt",
  "favoritePlaces",
] as const;

/**
 * Usage ideas page: fun ways to use TwiCa cards
 * おすすめの使い方ページ: カードの楽しい企画アイデアを紹介
 */
export default async function UsagesPage() {
  const session = await getSession();
  const t = await getTranslations("usagesPage");
  const tHeader = await getTranslations("header");
  const tGuide = await getTranslations("guidePage");

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="border-b border-gray-800">
        <div className="container mx-auto px-4 py-4">
          <nav className="flex items-center justify-between">
            <Link href="/" className="text-xl font-bold text-white">
              TwiCa
            </Link>
            {session ? (
              <Link
                href="/dashboard"
                className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
              >
                {tHeader("dashboard")}
              </Link>
            ) : (
              <Link
                href="/"
                className="text-gray-400 hover:text-white"
              >
                {tGuide("home")}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <h1 className="mb-4 text-3xl font-bold text-white">
          {t("title")}
        </h1>
        <p className="mb-10 text-gray-400">
          {t("lead")}
        </p>

        {/* Usage idea cards */}
        {/* おすすめの使い方カード */}
        <div className="grid gap-6 md:grid-cols-2">
          {usages.map((key) => (
            <div key={key} className="rounded-xl bg-gray-800 p-6">
              <h3 className="mb-2 text-lg font-semibold text-white">
                {t(`${key}.title`)}
              </h3>
              <p className="mb-2 text-sm text-gray-300">
                {t(`${key}.description`)}
              </p>
              <p className="mb-3 text-sm text-gray-500">
                {t(`${key}.example`)}
              </p>
              <p className="inline-block rounded bg-purple-600/20 px-2 py-1 text-xs text-purple-300">
                {t(`${key}.feature`)}
              </p>
            </div>
          ))}
        </div>

        {/* Getting started CTA */}
        {/* はじめるには CTA */}
        <section className="mt-12 rounded-xl border border-gray-700 bg-gray-800/50 p-6">
          <h2 className="mb-2 text-xl font-semibold text-purple-400">
            {t("getStarted.title")}
          </h2>
          <p className="mb-4 text-sm text-gray-400">
            {t("getStarted.description")}
          </p>
          <Link
            href="/guide"
            className="inline-block rounded-lg bg-purple-600 px-6 py-2 text-sm font-medium text-white hover:bg-purple-700"
          >
            {tGuide("title")}
          </Link>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
