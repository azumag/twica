import Link from "next/link";
import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import TosAcceptButton from "@/components/TosAcceptButton";

export const metadata: Metadata = {
  title: "利用規約 - TwiCa",
  description: "TwiCaの利用規約ページです。サービスの概要、ユーザーの責任と義務、利用制限について説明します。",
};

export default async function TosPage() {
  const session = await getSession();

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
        <article>
          <h1 className="mb-8 text-3xl font-bold text-white">
            利用規約
          </h1>
          <p className="mb-8 text-gray-400">
            この利用規約（以下「本規約」）は、TwiCa（以下「当サービス」）の利用に関する条件を定めるものです。
            ユーザーの皆さまには、本規約に従って当サービスをご利用いただきます。
          </p>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              第1条 サービスの概要
            </h2>
            <p className="text-gray-400">
              当サービスは、Twitch配信者向けのカードガチャシステムです。
              視聴者はチャンネルポイントを使ってガチャを引き、配信者が作成したオリジナルカードを収集できます。
            </p>
          </section>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              第2条 ユーザーの責任と義務
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
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

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              第3条 利用制限
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
              <li>
                当サービスは、18歳以上のユーザー様を対象としています。
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

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              第4条 知的財産権
            </h2>
            <p className="text-gray-400">
              当サービスに関する知的財産権は、運営者または正当な権利者に帰属します。
              ユーザーは、当サービスを通じて提供される内容を、運営者の事前書面による承諾なく、
              複製、配布、掲示等することは禁止します。
            </p>
          </section>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              第5条 免責事項
            </h2>
            <ul className="ml-6 list-disc space-y-2 text-gray-400">
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

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              第6条 変更と終了
            </h2>
            <p className="text-gray-400">
              運営者は、本規約を随時変更できるものとします。
              変更後の規約は、当サービス上に掲載した時点で効力を生じます。
              運営者は、当サービスを任意の時点で終了することができるものとします。
            </p>
          </section>

          <section className="mb-8 rounded-xl bg-gray-800 p-6">
            <h2 className="mb-4 text-xl font-semibold text-white">
              第7条 お問い合わせ先
            </h2>
            <p className="text-gray-400">
              当サービスに関するご質問は、
              <Link href="/about" className="text-purple-400 hover:text-purple-300">
                運営者情報ページ
              </Link>
              に記載の連絡先までお問い合わせください。
            </p>
          </section>

          {/* 利用規約同意ボタン - ログインユーザーで未同意の場合のみ表示 */}
          {/* TOS acceptance button - shown only for logged-in users who haven't accepted */}
          <TosAcceptButton isLoggedIn={!!session} hasAccepted={hasAccepted} />

          <div className="mt-12 border-t border-gray-700 pt-8">
            <p className="text-gray-500">
              最終更新日：2026年1月17日
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
                使い方
              </Link>
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
