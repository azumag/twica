import Link from "next/link";
import { getSession } from "@/lib/session";

export default async function Home() {
  const session = await getSession();

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-900 via-purple-800 to-indigo-900">
      <header className="container mx-auto px-4 py-6">
        <nav className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">TwiCa</h1>
          {session ? (
            <div className="flex items-center gap-4">
              <span className="text-white">{session.twitchDisplayName}</span>
              <Link
                href={session.role === 'streamer' ? '/dashboard' : '/collection'}
                className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
              >
                {session.role === 'streamer' ? 'ダッシュボード' : 'コレクション'}
              </Link>
              <Link
                href="/api/auth/logout"
                className="rounded-lg border border-white/30 px-4 py-2 text-white hover:bg-white/10"
              >
                ログアウト
              </Link>
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <Link
                href="/api/auth/twitch/login?role=user"
                className="rounded-lg border border-white/30 px-4 py-2 text-white hover:bg-white/10"
              >
                ログイン
              </Link>
            </div>
          )}
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

          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/api/auth/twitch/login?role=streamer"
              className="flex items-center gap-2 rounded-xl bg-purple-600 px-8 py-4 text-lg font-semibold text-white shadow-lg transition hover:bg-purple-700 hover:shadow-xl"
            >
              <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
              </svg>
              配信者として登録
            </Link>
            <Link
              href="/api/auth/twitch/login?role=user"
              className="flex items-center gap-2 rounded-xl border-2 border-white/30 bg-white/10 px-8 py-4 text-lg font-semibold text-white backdrop-blur transition hover:bg-white/20"
            >
              <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" />
              </svg>
              視聴者としてログイン
            </Link>
          </div>
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
      </main>

      <footer className="container mx-auto px-4 py-8 text-center text-purple-300">
        <p>&copy; 2025 TwiCa. All rights reserved.</p>
      </footer>
    </div>
  );
}
