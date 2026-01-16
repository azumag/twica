import Link from "next/link";
import type { Metadata } from "next";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "利用規約 - TwiCa",
  description: "TwiCaの利用規約ページです。サービスの概要、ユーザーの責任と義務、利用制限について説明します。",
};

export default async function TosPage() {
  const session = await getSession();

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-900 via-purple-800 to-indigo-900">
      <header className="container mx-auto px-4 py-6">
        <nav className="flex items-center justify-between">
          <Link href="/" className="text-2xl font-bold text-white">
            TwiCa
          </Link>
          {session && (
            <Link
              href="/dashboard"
              className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700"
            >
              ダッシュボード
            </Link>
          )}
        </nav>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <article className="rounded-2xl bg-white/10 p-8 backdrop-blur md:p-12">
          <h1 className="mb-8 text-3xl font-bold text-white md:text-4xl">
            利用規約
          </h1>
          <p className="mb-8 text-purple-200">
            この利用規約（以下「本規約」）は、TwiCa（以下「当サービス」）の利用に関する条件を定めるものです。
            ユーザーの皆さまには、本規約に従って当サービスをご利用いただきます。
          </p>

          <section className="mb-8">
            <h2 className="mb-4 text-2xl font-semibold text-white">
              第1条 サービスの概要
            </h2>
            <p className="mb-4 text-purple-200">
              当サービスは、Twitch配信者向けのカードガチャシステムです。
              視聴者はチャンネルポイントを使ってガチャを引き、配信者が作成したオリジナルカードを収集できます。
            </p>
          </section>

          <section className="mb-8">
            <h2 className="mb-4 text-2xl font-semibold text-white">
              第2条 ユーザーの責任と義務
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-purple-200">
              <li>
                ユーザーは、当サービスを法令および公序良俗に従って利用するものとします。
              </li>
              <li>
                ユーザーは、自らの責任においてTwitchアカウントを管理し、セキュリティを確保するものとします。
              </li>
              <li>
                ユーザーは、当サービスを通じて得たカード情報を個人利用の範囲内でのみ使用するものとします。
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="mb-4 text-2xl font-semibold text-white">
              第3条 利用制限
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-purple-200">
              <li>
                当サービスは、18歳以上のユーザー様を対象としています。
              </li>
              <li>
                当サービスを商業目的で利用する場合は、事前に運営者の許可を得るものとします。
              </li>
              <li>
                以下に該当する行為は禁止とします：
                <ul className="ml-6 mt-2 list-disc">
                  <li>当サービスの不正利用または改ざん</li>
                  <li>他のユーザーへの迷惑行為</li>
                  <li>著作権、商標権等の知的財産権の侵害</li>
                  <li>法令に違反する行為</li>
                </ul>
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="mb-4 text-2xl font-semibold text-white">
              第4条 知的財産権
            </h2>
            <p className="mb-4 text-purple-200">
              当サービスに関する知的財産権は、運営者または正当な権利者に帰属します。
              ユーザーは、当サービスを通じて提供される内容を、運営者の事前書面による承諾なく、
              複製、配布、掲示等することは禁止します。
            </p>
          </section>

          <section className="mb-8">
            <h2 className="mb-4 text-2xl font-semibold text-white">
              第5条 免責事項
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-purple-200">
              <li>
                当サービスは、提供するコンテンツ、サービス的一切について、その正確性、完全性、有用性について
                いかなる保証も行いません。
              </li>
              <li>
                当サービスに伴い発生した直接的、間接的な損害について、運営者は責任を負いません。
              </li>
              <li>
                メンテナンスやシステム障害等により、当サービスが利用できない場合があります。
              </li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="mb-4 text-2xl font-semibold text-white">
              第6条 変更と終了
            </h2>
            <p className="mb-4 text-purple-200">
              運営者は、本規約を随時変更できるものとします。
              変更後の規約は、当サービス上に掲載した時点で効力を生じます。
              運営者は、当サービスを任意の時点で終了することができるものとします。
            </p>
          </section>

          <section className="mb-8">
            <h2 className="mb-4 text-2xl font-semibold text-white">
              第7条 お問い合わせ先
            </h2>
            <p className="mb-4 text-purple-200">
              当サービスに関するご質問は、以下の窓口までお問い合わせください：
            </p>
            <p className="text-purple-200">
              メールアドレス：support@twica.example.com
            </p>
          </section>

          <section className="mt-12 border-t border-purple-700 pt-8">
            <p className="text-purple-300">
              最終更新日：2026年1月17日
            </p>
          </section>
        </article>
      </main>

      <footer className="container mx-auto px-4 py-8 text-center text-purple-300">
        <div className="mb-4 flex justify-center gap-6">
          <Link href="/" className="hover:text-white">
            ホーム
          </Link>
          <Link href="/tos" className="hover:text-white">
            利用規約
          </Link>
        </div>
        <p>&copy; 2026 TwiCa. All rights reserved.</p>
      </footer>
    </div>
  );
}
