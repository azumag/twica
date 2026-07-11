import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import PublicFooter from "@/components/PublicFooter";
import { getTosAcceptanceRow } from "@/lib/user-data";
import TosAcceptButton from "@/components/TosAcceptButton";

export const metadata: Metadata = {
  title: "Terms of Service - TwiCa",
  description: "TwiCa Terms of Service. Service overview, user responsibilities, and usage restrictions.",
};

export default async function TosPage() {
  const session = await getSession();
  const t = await getTranslations("tosPage");
  const tHeader = await getTranslations("header");
  const tGuidePage = await getTranslations("guidePage");

  // ログインユーザーの場合、TOS同意状態を確認
  // Check TOS acceptance status for logged-in users
  //
  // #711: users.tos_accepted_at の読み取りは user-data.ts の
  // getTosAcceptanceRow に委譲（isPgReadEnabled() による経路分岐は関数内部で
  // 行われるため、このページはフラグを意識しない）。
  let hasAccepted = false;
  if (session) {
    try {
      // 既存実装（`const { data: userData } = ...maybeSingle()`）と同じく error は
      // 意図的に無視する。getTosAcceptanceRow は throw せず { row, error } を返す
      // 契約のため、クエリエラー時は row=null → 下の判定が
      // `undefined !== null` → true となり、旧 postgrest 経路の
      // 「クエリエラー時も hasAccepted=true」という外部挙動がそのまま維持される
      // （src/lib/user-data.ts の TosAcceptanceRowResult コメント参照）。
      const { row: userData } = await getTosAcceptanceRow(session.twitchUserId);

      // 既存実装のクセ（修正は別Issue）: 行が存在しない場合 userData は null になり
      // `undefined !== null` → true と評価されるため、未登録ユーザーでも
      // hasAccepted: true 扱いになる。Phase 1 は挙動パリティ維持が最優先のため、
      // pg 経路でも忠実に再現する。
      hasAccepted = userData?.tos_accepted_at !== null;
    } catch {
      // エラーの場合は未同意として扱う（既存どおり「本当に throw された場合」
      // ——getSupabaseAdmin() の設定不備等——のみここに到達する。クエリエラーは
      // 上記のとおり row=null として無視され、この catch には来ない）
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

      <PublicFooter />
    </div>
  );
}
