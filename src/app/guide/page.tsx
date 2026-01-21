import Link from "next/link";
import type { Metadata } from "next";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "使い方 - TwiCa",
  description: "TwiCaの使い方ガイドです。視聴者向け・配信者向けの利用方法を説明します。",
};

/**
 * Guide page explaining how to use TwiCa
 * TwiCaの使い方を説明するガイドページ
 */
export default async function GuidePage() {
  const session = await getSession();

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
                ダッシュボード
              </Link>
            ) : (
              <Link
                href="/"
                className="text-gray-400 hover:text-white"
              >
                ホーム
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <h1 className="mb-8 text-3xl font-bold text-white">
          使い方
        </h1>

        {/* For viewers section */}
        {/* 視聴者向けセクション - id="viewer" でトップページからリンク可能 */}
        <section id="viewer" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            視聴者向け
          </h2>

          <div className="space-y-6">
            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  1
                </span>
                <h3 className="text-lg font-semibold text-white">
                  Twitchでログイン
                </h3>
              </div>
              <p className="text-gray-400">
                TwiCaのトップページから「Twitchでログイン」ボタンをクリックし、Twitchアカウントでログインします。
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  2
                </span>
                <h3 className="text-lg font-semibold text-white">
                  配信でチャネルポイントを使用
                </h3>
              </div>
              <p className="text-gray-400">
                TwiCaに対応した配信者の配信を視聴し、チャネルポイント報酬からカードガチャを実行します。
                配信者が設定した報酬（例：「カードガチャ」）をチャネルポイントで交換してください。
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  3
                </span>
                <h3 className="text-lg font-semibold text-white">
                  カードを獲得
                </h3>
              </div>
              <p className="text-gray-400">
                ガチャが実行されると、配信者が作成したオリジナルカードがランダムで獲得できます。
                獲得したカードは配信画面にも表示されます。
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  4
                </span>
                <h3 className="text-lg font-semibold text-white">
                  コレクションを確認
                </h3>
              </div>
              <p className="text-gray-400">
                ダッシュボードの「マイコレクション」から、獲得したカードを確認できます。
                レアリティごとの統計も表示されます。
              </p>
            </div>
          </div>
        </section>

        {/* For streamers section */}
        {/* 配信者向けセクション - id="streamer" でトップページからリンク可能 */}
        <section id="streamer" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            配信者向け
          </h2>
          <p className="mb-6 text-gray-400">
            ※ Twitchアフィリエイトまたはパートナーのステータスが必要です。
          </p>

          <div className="space-y-6">
            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  1
                </span>
                <h3 className="text-lg font-semibold text-white">
                  Twitchでログイン
                </h3>
              </div>
              <p className="text-gray-400">
                TwiCaにTwitchアカウントでログインします。
                アフィリエイト/パートナーのアカウントであれば、自動的に配信者機能が有効になります。
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  2
                </span>
                <h3 className="text-lg font-semibold text-white">
                  カードを作成
                </h3>
              </div>
              <p className="text-gray-400">
                ダッシュボードの「カード管理」から、オリジナルカードを作成します。
                カード名、画像、レアリティ、出現確率を設定できます。
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  3
                </span>
                <h3 className="text-lg font-semibold text-white">
                  チャネルポイント報酬を設定
                </h3>
              </div>
              <p className="text-gray-400">
                ダッシュボードの「配信設定」から、チャネルポイント報酬を選択または新規作成します。
                「保存 & EventSub登録」ボタンを押すと、Twitchとの連携が完了します。
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  4
                </span>
                <h3 className="text-lg font-semibold text-white">
                  OBSにオーバーレイを追加
                </h3>
              </div>
              <p className="text-gray-400">
                ダッシュボードの「配信設定」に表示されるOBSブラウザソースURLをコピーし、
                OBSのブラウザソースに追加します。推奨サイズは800x600です。
                これで、ガチャ結果が配信画面に表示されるようになります。
              </p>
            </div>

            <div className="rounded-xl bg-gray-800 p-6">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                  5
                </span>
                <h3 className="text-lg font-semibold text-white">
                  配信開始
                </h3>
              </div>
              <p className="text-gray-400">
                配信を開始すると、視聴者がチャネルポイントでカードガチャを実行できるようになります。
                獲得されたカードは自動的に配信画面に表示されます。
              </p>
            </div>
          </div>
        </section>

        {/* Tips section */}
        {/* ヒントセクション */}
        <section>
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            ヒント
          </h2>

          <div className="rounded-xl bg-gray-800 p-6">
            <ul className="space-y-3 text-gray-400">
              <li className="flex items-start gap-2">
                <span className="text-purple-400">•</span>
                カードの出現確率は「重み」で設定します。全カードの重みの合計に対する割合が実際の出現確率になります。
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400">•</span>
                カードは「配布停止」にすることで、一時的にガチャから除外できます。
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400">•</span>
                アップロード画像は400x400ピクセルに自動トリミングされます。画像URL指定の場合はトリミングされず、そのまま使用されます。
              </li>
              <li className="flex items-start gap-2">
                <span className="text-purple-400">•</span>
                EventSubのステータスが「接続中」になっていることを確認してから配信を開始してください。
              </li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-gray-800">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="text-sm text-gray-500">&copy; 2025 TwiCa</p>
            <div className="flex gap-6">
              <Link href="/tos" className="text-sm text-gray-500 hover:text-gray-300">
                利用規約
              </Link>
              <Link href="/about" className="text-sm text-gray-500 hover:text-gray-300">
                運営者情報
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
