import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import TosAcceptButton from "@/components/TosAcceptButton";

export const metadata: Metadata = {
  title: "Terms of Service - TwiCa",
  description: "TwiCa Terms of Service. Service overview, user responsibilities, and usage restrictions.",
};

export default async function TosPage() {
  const session = await getSession();
  const t = await getTranslations("tosPage");
  const tHeader = await getTranslations("header");
  const tFooter = await getTranslations("footer");
  const tGuidePage = await getTranslations("guidePage");

  // ログインユーザーの場合、TOS同意状態を確認
  // Check TOS acceptance status for logged-in users
  let hasAccepted = false;
  if (session) {
    try {
      const supabaseAdmin = getSupabaseAdmin();
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('tos_accepted_at')
        .eq('twitch_user_id', session.twitchUserId)
        .single();

      hasAccepted = userData?.tos_accepted_at !== null;
    } catch {
      // エラーの場合は未同意として扱う
      // Treat as not accepted on error
      hasAccepted = false;
    }
  }

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

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article1.title")}
            </h2>
            <p className="text-gray-400">
              {t("article1.content")}
            </p>
          </section>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article2.title")}
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
              <li>
                {t("article2.item1")}
              </li>
              <li>
                {t("article2.item2")}
              </li>
              <li>
                {t("article2.item3")}
              </li>
            </ul>
          </section>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article3.title")}
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
              <li>
                {t("article3.item1")}
              </li>
              <li>
                {t("article3.item2")}
                <ul className="ml-6 mt-2 list-disc">
                  <li>{t("article3.prohibited1")}</li>
                  <li>{t("article3.prohibited2")}</li>
                  <li>{t("article3.prohibited3")}</li>
                  <li>{t("article3.prohibited4")}</li>
                </ul>
              </li>
            </ul>
          </section>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article4.title")}
            </h2>
            <p className="text-gray-400">
              {t("article4.content")}
            </p>
          </section>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article5.title")}
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
              <li>
                {t("article5.item1")}
              </li>
              <li>
                {t("article5.item2")}
              </li>
              <li>
                {t("article5.item3")}
              </li>
            </ul>
          </section>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article6.title")}
            </h2>
            <p className="text-gray-400">
              {t("article6.content")}
            </p>
          </section>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              {t("article7.title")}
            </h2>
            <p className="text-gray-400">
              {t("article7.content")}
              <Link href="/about" className="text-purple-400 hover:text-purple-300">
                {t("article7.operatorInfoLink")}
              </Link>
              {t("article7.contentEnd")}
            </p>
          </section>

          {/* 利用規約同意ボタン - ログインユーザーで未同意の場合のみ表示 */}
          {/* TOS acceptance button - shown only for logged-in users who haven't accepted */}
          <TosAcceptButton isLoggedIn={!!session} hasAccepted={hasAccepted} />

          <div className="mt-12 border-t border-gray-700 pt-8">
            <p className="text-gray-500">
              {t("lastUpdated", { date: "2026-01-17" })}
            </p>
          </div>
        </article>
      </main>

      <footer className="border-t border-gray-800">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="text-sm text-gray-500">&copy; 2025 TwiCa</p>
            <div className="flex gap-6">
              <Link href="/guide" className="text-sm text-gray-500 hover:text-gray-300">
                {tFooter("guide")}
              </Link>
              <Link href="/tos" className="text-sm text-gray-500 hover:text-gray-300">
                {tFooter("tos")}
              </Link>
              <Link href="/about" className="text-sm text-gray-500 hover:text-gray-300">
                {tFooter("about")}
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
