import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import PublicFooter from "@/components/PublicFooter";

export const metadata: Metadata = {
  title: "Guide - TwiCa",
  description: "TwiCa usage guide for viewers and streamers.",
};

/**
 * Guide page explaining how to use TwiCa
 * TwiCaの使い方を説明するガイドページ
 */
export default async function GuidePage() {
  const session = await getSession();
  const t = await getTranslations("guidePage");
  const tHeader = await getTranslations("header");

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
                {t("home")}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <h1 className="mb-8 text-3xl font-bold text-white">
          {t("title")}
        </h1>

        {/* For viewers section */}
        {/* 視聴者向けセクション - id="viewer" でトップページからリンク可能 */}
        <section id="viewer" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("viewer.title")}
          </h2>

          <div className="space-y-6">
            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  1
                </span>
                <h3 className="text-lg font-semibold text-white">
                  {t("viewer.step1.title")}
                </h3>
              </div>
              <p className="text-gray-400">
                {t("viewer.step1.description")}
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  2
                </span>
                <h3 className="text-lg font-semibold text-white">
                  {t("viewer.step2.title")}
                </h3>
              </div>
              <p className="text-gray-400">
                {t("viewer.step2.description")}
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  3
                </span>
                <h3 className="text-lg font-semibold text-white">
                  {t("viewer.step3.title")}
                </h3>
              </div>
              <p className="text-gray-400">
                {t("viewer.step3.description")}
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  4
                </span>
                <h3 className="text-lg font-semibold text-white">
                  {t("viewer.step4.title")}
                </h3>
              </div>
              <p className="text-gray-400">
                {t("viewer.step4.description")}
              </p>
            </div>
          </div>
        </section>

        {/* For streamers section */}
        {/* 配信者向けセクション - id="streamer" でトップページからリンク可能 */}
        <section id="streamer" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("streamer.title")}
          </h2>
          <p className="mb-6 text-gray-400">
            {t("streamer.requiresAffiliate")}
          </p>

          <div className="space-y-6">
            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  1
                </span>
                <h3 className="text-lg font-semibold text-white">
                  {t("streamer.step1.title")}
                </h3>
              </div>
              <p className="text-gray-400">
                {t("streamer.step1.description")}
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  2
                </span>
                <h3 className="text-lg font-semibold text-white">
                  {t("streamer.step2.title")}
                </h3>
              </div>
              <p className="text-gray-400">
                {t("streamer.step2.description")}
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  3
                </span>
                <h3 className="text-lg font-semibold text-white">
                  {t("streamer.step3.title")}
                </h3>
              </div>
              <p className="text-gray-400">
                {t("streamer.step3.description")}
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  4
                </span>
                <h3 className="text-lg font-semibold text-white">
                  {t("streamer.step4.title")}
                </h3>
              </div>
              <p className="text-gray-400">
                {t("streamer.step4.description")}
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  5
                </span>
                <h3 className="text-lg font-semibold text-white">
                  {t("streamer.step5.title")}
                </h3>
              </div>
              <p className="text-gray-400">
                {t("streamer.step5.description")}
              </p>
            </div>
          </div>
        </section>

        {/* Tips section */}
        {/* ヒントセクション */}
        <section>
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("tips.title")}
          </h2>

          <div className="rounded-xl bg-gray-800 p-6">
            <ul className="space-y-3 text-gray-400">
              <li className="flex items-start gap-2">
                <span className="text-purple-400">•</span>
                {t("tips.tip1")}
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400">•</span>
                {t("tips.tip2")}
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400">•</span>
                {t("tips.tip3")}
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400">•</span>
                {t("tips.tip4")}
              </li>
            </ul>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
