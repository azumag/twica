import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Privacy Policy - TwiCa",
  description: "TwiCa Privacy Policy. Information about data collection, usage, and protection.",
};

/**
 * Privacy policy page
 * プライバシーポリシーページ
 */
export default async function PrivacyPage() {
  const session = await getSession();
  const t = await getTranslations("privacyPage");
  const tHeader = await getTranslations("header");
  const tFooter = await getTranslations("footer");
  const tGuidePage = await getTranslations("guidePage");

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
                {tGuidePage("home")}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <article>
          <h1 className="mb-8 text-3xl font-bold text-white">
            {t("title")}
          </h1>
          <p className="mb-8 text-gray-400">
            {t("intro")}
          </p>

          {/* 第1条 収集する情報 */}
          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article1.title")}
            </h2>
            <p className="mb-4 text-gray-400">
              {t("article1.intro")}
            </p>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
              <li>{t("article1.item1")}</li>
              <li>{t("article1.item2")}</li>
              <li>{t("article1.item3")}</li>
              <li>{t("article1.item4")}</li>
            </ul>
          </section>

          {/* 第2条 情報の利用目的 */}
          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article2.title")}
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
              <li>{t("article2.item1")}</li>
              <li>{t("article2.item2")}</li>
              <li>{t("article2.item3")}</li>
              <li>{t("article2.item4")}</li>
            </ul>
          </section>

          {/* 第3条 第三者サービス */}
          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article3.title")}
            </h2>
            <p className="mb-4 text-gray-400">
              {t("article3.intro")}
            </p>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
              <li>{t("article3.item1")}</li>
              <li>{t("article3.item2")}</li>
              <li>{t("article3.item3")}</li>
            </ul>
          </section>

          {/* 第4条 Cookieの使用 */}
          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article4.title")}
            </h2>
            <p className="text-gray-400">
              {t("article4.content")}
            </p>
          </section>

          {/* 第5条 情報の共有と開示 */}
          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article5.title")}
            </h2>
            <p className="mb-4 text-gray-400">
              {t("article5.intro")}
            </p>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
              <li>{t("article5.item1")}</li>
              <li>{t("article5.item2")}</li>
            </ul>
          </section>

          {/* 第6条 データの保管と削除 */}
          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article6.title")}
            </h2>
            <p className="text-gray-400">
              {t("article6.content")}
            </p>
          </section>

          {/* 第7条 ポリシーの変更 */}
          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article7.title")}
            </h2>
            <p className="text-gray-400">
              {t("article7.content")}
            </p>
          </section>

          {/* 第8条 お問い合わせ先 */}
          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article8.title")}
            </h2>
            <p className="text-gray-400">
              {t("article8.content")}
              <Link href="/about" className="text-purple-400 hover:text-purple-300">
                {t("article8.operatorInfoLink")}
              </Link>
              {t("article8.contentEnd")}
            </p>
          </section>

          <div className="mt-12 border-t border-gray-700 pt-8">
            <p className="text-gray-500">
              {t("lastUpdated", { date: "2026-02-21" })}
            </p>
          </div>
        </article>
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
