import Link from "next/link";
import { getSession } from "@/lib/session";
import DevelopmentNotice from "@/components/DevelopmentNotice";
import { TwitchLoginButtonWithIcon } from "@/components/TwitchLoginButton";
import TopPageHeader from "@/components/TopPageHeader";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();

  // Prepare session data for client component (without sensitive info)
  const sessionData = session ? {
    twitchUserId: session.twitchUserId,
    twitchUsername: session.twitchUsername,
    twitchDisplayName: session.twitchDisplayName,
    twitchProfileImageUrl: session.twitchProfileImageUrl,
    broadcasterType: session.broadcasterType,
  } : null;

  return (
    <div className="min-h-screen bg-gray-900">
      <DevelopmentNotice />
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
            Twitch チャネルポイント連携
            <br />
            <span className="text-purple-400">
              デジタルカードコレクション
            </span>
          </h2>
          <p className="mb-12 text-lg text-gray-400">
            TwiCaは、Twitchのチャネルポイントを活用した
            デジタルトレーディングカード配布システムです。
            <br />
            視聴者はポイントを使用してカードを獲得し、コレクションを構築できます。
          </p>

          {session ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-8 py-3 font-medium text-white transition hover:bg-purple-700"
            >
              ダッシュボードへ
            </Link>
          ) : (
            <TwitchLoginButtonWithIcon
              className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-8 py-3 font-medium text-white transition hover:bg-purple-700 disabled:opacity-50"
            />
          )}
        </div>

        <div className="mt-20 grid gap-6 md:grid-cols-3">
          <div className="rounded-xl bg-gray-800 p-6">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-purple-600">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-semibold text-white">カード収集</h3>
            <p className="text-sm text-gray-400">
              チャネルポイントを使用してガチャを実行し、配信者が作成したオリジナルカードを収集できます。
            </p>
          </div>
          <div className="rounded-xl bg-gray-800 p-6">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-purple-600">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-semibold text-white">レアリティシステム</h3>
            <p className="text-sm text-gray-400">
              コモン、レア、エピック、レジェンダリーの4段階のレアリティ。確率に基づいてカードが排出されます。
            </p>
          </div>
          <div className="rounded-xl bg-gray-800 p-6">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-purple-600">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-semibold text-white">配信連携</h3>
            <p className="text-sm text-gray-400">
              OBSブラウザソースでガチャ演出を配信に表示。視聴者とリアルタイムで結果を共有できます。
            </p>
          </div>
        </div>

        {/* Info for streamers */}
        <div className="mx-auto mt-16 max-w-2xl rounded-xl bg-gray-800 p-6">
          <h3 className="mb-3 text-lg font-semibold text-white">配信者向け機能</h3>
          <p className="text-sm text-gray-400">
            Twitchアフィリエイトまたはパートナーステータスをお持ちの方は、以下の機能をご利用いただけます：
          </p>
          <ul className="mt-3 space-y-1 text-sm text-gray-400">
            <li className="flex items-center gap-2">
              <span className="text-purple-400">•</span>
              オリジナルカードの作成・管理
            </li>
            <li className="flex items-center gap-2">
              <span className="text-purple-400">•</span>
              チャネルポイント報酬との連携設定
            </li>
            <li className="flex items-center gap-2">
              <span className="text-purple-400">•</span>
              配信用オーバーレイのカスタマイズ
            </li>
          </ul>
        </div>
      </main>

      <footer className="border-t border-gray-800">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="text-sm text-gray-500">&copy; 2025 TwiCa</p>
            <div className="flex gap-6">
              <Link href="/tos" className="text-sm text-gray-500 hover:text-gray-300">
                利用規約
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
