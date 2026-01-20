import Link from "next/link";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { COOKIE_NAMES } from "@/lib/constants";
import { logger } from "@/lib/logger";
import DevelopmentNotice from "@/components/DevelopmentNotice";
import { TwitchLoginButtonWithIcon } from "@/components/TwitchLoginButton";
import TopPageHeader from "@/components/TopPageHeader";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Debug: log cookie state in RSC
  const cookieStore = await cookies();
  const allCookies = cookieStore.getAll();
  const sessionCookieValue = cookieStore.get(COOKIE_NAMES.SESSION)?.value;

  logger.info('Top page RSC: Cookie debug', {
    cookieCount: allCookies.length,
    cookieNames: allCookies.map(c => c.name),
    hasSessionCookie: !!sessionCookieValue,
    sessionCookieLength: sessionCookieValue?.length || 0,
  });

  const session = await getSession();

  logger.info('Top page RSC: Session result', {
    hasSession: !!session,
    twitchUserId: session?.twitchUserId || null,
  });

  // Prepare session data for client component (without sensitive info)
  const sessionData = session ? {
    twitchUserId: session.twitchUserId,
    twitchUsername: session.twitchUsername,
    twitchDisplayName: session.twitchDisplayName,
    twitchProfileImageUrl: session.twitchProfileImageUrl,
    broadcasterType: session.broadcasterType,
  } : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-900 via-purple-800 to-indigo-900">
      <DevelopmentNotice />
      <header className="container mx-auto px-4 py-6">
        <nav className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">TwiCa</h1>
          <TopPageHeader initialSession={sessionData} />
        </nav>
      </header>

      <main className="container mx-auto px-4 py-16">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="mb-6 text-5xl font-bold text-white">
            チャネルポイントで
            <br />
            <span className="bg-gradient-to-r from-yellow-400 to-orange-500 bg-clip-text text-transparent">
              カードをゲット
            </span>
          </h2>
          <p className="mb-12 text-xl text-purple-200">
            TwiCaは、Twitchのチャネルポイントを使って
            <br />
            配信者オリジナルのトレーディングカードを集められるサービスです
          </p>

          {session ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-8 py-4 text-lg font-semibold text-white shadow-lg transition hover:bg-purple-700 hover:shadow-xl"
            >
              ダッシュボードへ移動
            </Link>
          ) : (
            <TwitchLoginButtonWithIcon
              className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-8 py-4 text-lg font-semibold text-white shadow-lg transition hover:bg-purple-700 hover:shadow-xl disabled:opacity-50"
            />
          )}
        </div>

        <div className="mt-24 grid gap-8 md:grid-cols-3">
          <div className="rounded-2xl bg-white/10 p-8 backdrop-blur">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-yellow-500 text-2xl">
              🎴
            </div>
            <h3 className="mb-2 text-xl font-bold text-white">カードを集めよう</h3>
            <p className="text-purple-200">
              チャネルポイントを使ってガチャを回し、配信者オリジナルのカードをコレクション
            </p>
          </div>
          <div className="rounded-2xl bg-white/10 p-8 backdrop-blur">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-purple-500 text-2xl">
              ✨
            </div>
            <h3 className="mb-2 text-xl font-bold text-white">レアカードを狙え</h3>
            <p className="text-purple-200">
              コモン、レア、エピック、レジェンダリー...運試しでレアカードをゲット
            </p>
          </div>
          <div className="rounded-2xl bg-white/10 p-8 backdrop-blur">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500 text-2xl">
              📺
            </div>
            <h3 className="mb-2 text-xl font-bold text-white">配信を盛り上げ</h3>
            <p className="text-purple-200">
              ガチャ演出が配信に表示され、視聴者と一緒に結果を楽しめる
            </p>
          </div>
        </div>

        {/* Info for streamers */}
        <div className="mx-auto mt-16 max-w-2xl rounded-2xl bg-white/10 p-8 text-center backdrop-blur">
          <h3 className="mb-4 text-xl font-bold text-white">配信者の方へ</h3>
          <p className="text-purple-200">
            Twitchアフィリエイト・パートナーの方は、ログイン後に配信者向け機能（カード管理、チャネルポイント設定など）をご利用いただけます。
          </p>
        </div>
      </main>

      <footer className="container mx-auto px-4 py-8 text-center text-purple-300">
        <div className="mb-4 flex justify-center gap-6">
          <Link href="/tos" className="hover:text-white">
            利用規約
          </Link>
        </div>
        <p>&copy; 2025 TwiCa. All rights reserved.</p>
      </footer>
    </div>
  );
}
