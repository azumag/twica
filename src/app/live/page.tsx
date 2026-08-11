import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import LiveDirectory from "@/components/LiveDirectory";
import PublicFooter from "@/components/PublicFooter";
import { getLiveDirectory } from "@/lib/live-directory";
import { getSession } from "@/lib/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("livePage");
  return {
    title: t("metadata.title"),
    description: t("metadata.description"),
  };
}

/**
 * 公開の配信中ディレクトリ。
 *
 * getSession() は既存公開ページと同じくヘッダー導線の出し分けだけに使う。
 * 未ログインをredirectしないため、一覧・統計・ソートは認証なしで閲覧できる。
 * ページrevalidateはOpenNext本番構成で機能しないため追加せず、鮮度と外部API原価は
 * getLiveDirectory() のCloudflare KV 60秒キャッシュへ一元化している。
 */
export default async function LivePage() {
  const [session, entries, t, tHeader] = await Promise.all([
    getSession(),
    getLiveDirectory(),
    getTranslations("livePage"),
    getTranslations("header"),
  ]);

  // Serverで基準時刻を1回だけ確定し、Client ComponentのSSR/hydration間で
  // 配信経過時間がずれないようにする。
  const referenceTime = new Date().toISOString();

  return (
    <div className="min-h-screen bg-gray-900">
      <header className="border-b border-gray-800">
        <div className="container mx-auto max-w-7xl px-4 py-4">
          <nav
            aria-label={t("navigationLabel")}
            className="flex items-center justify-between gap-4"
          >
            <Link href="/" className="text-xl font-bold text-white">
              TwiCa
            </Link>
            {session ? (
              <Link
                href="/dashboard"
                className="rounded-lg bg-purple-600 px-4 py-2 text-white transition hover:bg-purple-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
              >
                {tHeader("dashboard")}
              </Link>
            ) : (
              <Link
                href="/"
                className="text-gray-400 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
              >
                {t("home")}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-7xl px-4 py-10 sm:py-12">
        <div className="mb-10 max-w-3xl">
          <h1 className="text-3xl font-bold text-white sm:text-4xl">{t("title")}</h1>
          <p className="mt-3 text-base leading-7 text-gray-400">{t("description")}</p>
        </div>

        <LiveDirectory entries={entries} referenceTime={referenceTime} />
      </main>

      <PublicFooter />
    </div>
  );
}
