import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "支援特典について - TwiCa",
  description: "TwiCa の支援特典一覧をご確認ください。",
};

/**
 * 支援特典説明ページ
 * 特典一覧・コードの取得・有効化方法を案内する
 */
export default async function PlansPage() {
  const session = await getSession();
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
              <Link href="/" className="text-gray-400 hover:text-white">
                {tGuidePage("home")}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <article>
          <h1 className="mb-4 text-3xl font-bold text-white">
            支援特典について
          </h1>
          <p className="mb-10 text-gray-400 leading-relaxed">
            TwiCa は無料でご利用いただけるサービスです。
            <a
              href="https://azumag.fanbox.cc/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 hover:text-purple-300 underline"
            >
              FANBOX
            </a>
            などで TwiCa を支援してくださった方には、感謝の気持ちとしてストレージ容量拡張などの特典をご提供しています。
          </p>

          {/* 特典一覧 */}
          <section className="mb-12">
            <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
              特典一覧
            </h2>

            <div className="grid gap-4 md:grid-cols-2">
              {/* 素地 */}
              <div className="rounded-xl bg-gray-800 p-6 border border-gray-700">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-full bg-gray-600 px-3 py-1 text-sm font-medium text-white">
                    素地
                  </span>
                  <span className="text-sm text-gray-500">無料</span>
                </div>
                <ul className="space-y-2 text-sm text-gray-400">
                  <li className="flex items-start gap-2">
                    <span className="text-gray-500 mt-0.5">•</span>
                    <span>ストレージ容量: 10MB</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-gray-500 mt-0.5">•</span>
                    <span>カード画像最大幅: 800px</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-gray-500 mt-0.5">•</span>
                    <span>1ファイルあたり上限: 1MB</span>
                  </li>
                </ul>
              </div>

              {/* 助力 */}
              <div className="rounded-xl bg-gray-800 p-6 border border-blue-700/50">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-full bg-blue-600 px-3 py-1 text-sm font-medium text-white">
                    助力
                  </span>
                  <span className="text-sm text-gray-500">支援コード必要</span>
                </div>
                <ul className="space-y-2 text-sm text-gray-400">
                  <li className="flex items-start gap-2">
                    <span className="text-blue-400 mt-0.5">✓</span>
                    <span>ストレージ <span className="text-blue-400 font-medium">+250MB</span></span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-400 mt-0.5">✓</span>
                    <span>カード画像最大幅: <span className="text-blue-400 font-medium">1920px（Full HD）</span></span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-400 mt-0.5">✓</span>
                    <span>1ファイルあたり上限: <span className="text-blue-400 font-medium">5MB</span></span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-400 mt-0.5">✓</span>
                    <span>支援者向け問い合わせフォーム</span>
                  </li>
                </ul>
              </div>

              {/* ご贔屓 */}
              <div className="rounded-xl bg-gray-800 p-6 border border-yellow-700/50">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-full bg-yellow-600 px-3 py-1 text-sm font-medium text-white">
                    ご贔屓
                  </span>
                  <span className="text-sm text-gray-500">支援コード必要</span>
                </div>
                <ul className="space-y-2 text-sm text-gray-400">
                  <li className="flex items-start gap-2">
                    <span className="text-yellow-400 mt-0.5">✓</span>
                    <span>ストレージ <span className="text-yellow-400 font-medium">+500MB</span></span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-yellow-400 mt-0.5">✓</span>
                    <span>カード画像最大幅: <span className="text-yellow-400 font-medium">3840px（4K）</span></span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-yellow-400 mt-0.5">✓</span>
                    <span>1ファイルあたり上限: <span className="text-yellow-400 font-medium">10MB</span></span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-yellow-400 mt-0.5">✓</span>
                    <span>支援者向け問い合わせフォーム</span>
                  </li>
                </ul>
              </div>

              {/* Twitchサブスク */}
              <div className="rounded-xl bg-gray-800 p-6 border border-purple-700/50">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-full bg-purple-600 px-3 py-1 text-sm font-medium text-white">
                    Twitchサブスク特典
                  </span>
                  <span className="text-sm text-gray-500">有効化が必要</span>
                </div>
                <ul className="space-y-2 text-sm text-gray-400">
                  <li className="flex items-start gap-2">
                    <span className="text-purple-400 mt-0.5">✓</span>
                    <span>ご贔屓と同等の特典</span>
                  </li>
                </ul>
                {/* 適用条件・方法の説明 */}
                <div className="mt-4 rounded-lg bg-purple-900/20 border border-purple-700/30 p-3">
                  <p className="text-xs text-gray-400 mb-2">
                    <a
                      href="https://www.twitch.tv/azumagbanjo"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-purple-400 hover:text-purple-300 underline"
                    >
                      作者：あずまぐ（@azumagbanjo）の Twitch チャネル
                    </a>
                    をサブスクライブしている方へのおまけ特典です。
                  </p>
                  <p className="text-xs text-purple-300 font-medium mb-1">有効化方法</p>
                  <p className="text-xs text-gray-400">アカウント設定の「Twitchサブスク確認」から権限を付与して有効化</p>
                </div>
              </div>
            </div>
          </section>

          {/* コードの取得方法 */}
          <section className="mb-12">
            <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
              支援コードの取得方法
            </h2>

            <div className="space-y-4">
              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  FANBOX で支援する
                </h3>
                <p className="mb-3 text-gray-400">
                  <a
                    href="https://azumag.fanbox.cc/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300 underline"
                  >
                    azumag の FANBOX
                  </a>
                  で月額支援をいただいた方に支援コードをお届けしています。支援後、FANBOX のメッセージまたは投稿にてコードをご確認ください。
                </p>
                <a
                  href="https://azumag.fanbox.cc/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700"
                >
                  FANBOX を見る
                </a>
              </div>

              {/* Twitchサブスク特典の説明 */}
              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  Twitchサブスク特典（おまけ）
                </h3>
                <p className="mb-4 text-gray-400">
                  <a
                    href="https://www.twitch.tv/azumagbanjo"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300 underline font-medium"
                  >
                    作者：あずまぐ（@azumagbanjo）の Twitch 配信チャネル
                  </a>
                  をサブスクライブしている方へのおまけ特典です。
                </p>
                <p className="mb-2 text-sm font-medium text-white">有効化方法</p>
                <p className="mb-5 text-sm text-gray-400">
                  アカウント設定の「Twitchサブスク確認」から権限を付与して有効化してください。
                </p>
                <a
                  href="https://www.twitch.tv/azumagbanjo"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700"
                >
                  Twitch チャネルを見る
                </a>
              </div>
            </div>
          </section>

          {/* コードの有効化方法 */}
          <section className="mb-12">
            <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
              支援コードの有効化方法
            </h2>

            <div className="rounded-xl bg-gray-800 p-6">
              <ol className="space-y-3 text-gray-400">
                <li className="flex items-start gap-3">
                  <span className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-purple-600 text-xs font-bold text-white">1</span>
                  <span>TwiCa にログインして、ダッシュボードを開く</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-purple-600 text-xs font-bold text-white">2</span>
                  <span>左メニューの「アカウント設定」をクリック</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-purple-600 text-xs font-bold text-white">3</span>
                  <span>「支援」セクションで支援コードを入力して「有効化」ボタンをクリック</span>
                </li>
              </ol>
              {session && (
                <div className="mt-4">
                  <Link
                    href="/dashboard/account"
                    className="inline-block rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700"
                  >
                    アカウント設定へ
                  </Link>
                </div>
              )}
            </div>
          </section>

          {/* 今後の展望 */}
          <section className="mb-12">
            <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
              今後予定している特典
            </h2>
            <div className="rounded-xl bg-gray-800 p-6">
              <ul className="ml-4 list-disc space-y-2 text-gray-400">
                <li>効果音の細かい設定（レアリティ別の効果音など）</li>
                <li>動画カード対応</li>
                <li>複数コレクション</li>
                <li>N連ガチャ</li>
                <li>全期間統計</li>
              </ul>
            </div>
          </section>
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
