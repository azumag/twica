import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "リリースノート - TwiCa",
  description: "TwiCa の最新機能・改善内容をご確認ください。",
};

/**
 * リリースノートページ
 * v1.27.0: 支援特典システム・Twitchサブスク確認・問い合わせフォーム
 */
export default async function ReleasesPage() {
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
          <h1 className="mb-10 text-3xl font-bold text-white">
            TwiCa リリースノート
          </h1>

          {/* v1.27.0 - 支援特典・Twitchサブスク確認・問い合わせフォーム */}
          <div className="mb-16">
            <div className="mb-8">
              <div className="mb-2 inline-block rounded-full bg-purple-600 px-3 py-1 text-sm font-medium text-white">
                v1.27.0
              </div>
              <p className="mt-2 text-sm text-gray-500">2026-02-25</p>
            </div>

            {/* 支援特典システム */}
            <section className="mb-10">
              <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
                支援特典システム
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    支援特典の導入
                  </h3>
                  <p className="text-gray-400">
                    <a href="https://azumag.fanbox.cc/" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">FANBOX</a> などで TwiCa を支援してくださっている方に、感謝の気持ちとしてストレージ容量の追加特典を提供するシステムを導入しました。支援コードを入力するだけで、特典が有効化されます。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-3 text-lg font-semibold text-white">
                    特典一覧
                  </h3>
                  <ul className="ml-4 list-disc space-y-2 text-gray-400">
                    <li><span className="text-blue-400 font-medium">助力</span> - ストレージ容量 +250MB、Full HD（1920px幅）画像対応</li>
                    <li><span className="text-yellow-400 font-medium">ご贔屓</span> - ストレージ容量 +500MB、4K（3840px幅）画像対応</li>
                    <li><span className="text-purple-400 font-medium">Twitchサブスク特典</span> - <a href="https://www.twitch.tv/azumagbanjo" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">作者：あずまぐ（@azumagbanjo）の Twitch チャンネル</a>をサブスクしている方に自動適用（ご贔屓同等の特典）</li>
                  </ul>
                  <p className="mt-3 text-sm text-gray-500">
                    支援コードの入力はダッシュボードの「<a href="/dashboard/account" className="text-purple-400 hover:text-purple-300 underline">アカウント設定</a>」から行えます。詳細は
                    <a href="/plans" className="text-purple-400 hover:text-purple-300 underline ml-1">支援特典について</a>
                    をご覧ください。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    高画質カード登録
                  </h3>
                  <p className="text-gray-400">
                    支援特典に応じて、カード画像の登録解像度が向上します。助力はFull HD（1920px幅、上限5MB）、ご贔屓は4K（3840px幅、上限10MB）まで対応します。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    特典の解除
                  </h3>
                  <p className="text-gray-400">
                    アカウント設定から素地に戻せます。解除後は、特典（追加ストレージ等）が失われます。
                  </p>
                </div>
              </div>
            </section>

            {/* Twitchサブスク確認 */}
            <section className="mb-10">
              <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
                Twitch サブスク確認
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    Twitch チャンネルサブスクによる特典自動適用
                  </h3>
                  <p className="text-gray-400">
                    <a href="https://www.twitch.tv/azumagbanjo" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">作者：あずまぐ（@azumagbanjo）の Twitch チャンネル</a>をサブスクライブしている方は、アカウント設定の「Twitchサブスク確認」からサブスク状態を確認するだけで、ご贔屓同等の特典が自動適用されます。支援コードの入力は不要です。
                  </p>
                </div>
              </div>
            </section>

            {/* 支援者向け問い合わせフォーム */}
            <section className="mb-10">
              <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
                支援者向け問い合わせフォーム
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    専用の問い合わせ機能
                  </h3>
                  <p className="text-gray-400">
                    助力・ご贔屓・Twitchサブスク特典をご利用の方向けに、専用の問い合わせフォームを追加しました。ダッシュボードの「問い合わせ」メニューからアクセスできます。
                  </p>
                </div>
              </div>
            </section>

            {/* 今後の予定 */}
            <section className="mb-10">
              <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
                今後の予定
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-3 text-lg font-semibold text-white">
                    実装予定の特典
                  </h3>
                  <ul className="ml-4 list-disc space-y-2 text-gray-400">
                    <li>効果音の細かい設定（レアリティ別の効果音など）</li>
                    <li>動画カード対応</li>
                    <li>複数コレクション</li>
                    <li>N連ガチャ</li>
                    <li>全期間統計</li>
                  </ul>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    今後の展望
                  </h3>
                  <p className="text-gray-400">
                    将来的にはクレジットカード決済による機能別のアンロックを検討しています。FANBOXよりも手頃な価格で個別機能を解放できる仕組みを目指していますが、法的手続き等の関係で実装にはもう少し時間がかかる見込みです。
                  </p>
                </div>
              </div>
            </section>

            {/* その他の改善・修正 */}
            <section className="mb-10">
              <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
                その他の改善・修正
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-3 text-lg font-semibold text-white">
                    改善
                  </h3>
                  <ul className="ml-4 list-disc space-y-2 text-gray-400">
                    <li>アカウント設定ページに現在の特典の表示を追加</li>
                    <li>ストレージ容量超過時にカード管理画面でわかりやすい警告を表示</li>
                    <li>支援特典ページ（/plans）を新規追加</li>
                  </ul>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-3 text-lg font-semibold text-white">
                    修正
                  </h3>
                  <ul className="ml-4 list-disc space-y-2 text-gray-400">
                    <li>ログアウト後の再ログイン時に Twitch チャット通知のスコープが失われる問題を修正</li>
                    <li>再認証フローの識別を改善し、スコープの引き継ぎを正確に制御</li>
                  </ul>
                </div>
              </div>
            </section>
          </div>

          {/* v1.26.0 - 正式リリース */}
          <div className="mb-16">
            <div className="mb-8">
              <div className="mb-2 inline-block rounded-full bg-gray-600 px-3 py-1 text-sm font-medium text-white">
                v1.26.0
              </div>
              <p className="mt-2 text-lg text-gray-400 font-medium">
                ベータ版 → 正式リリース
              </p>
            </div>

            <p className="mb-10 text-gray-400 leading-relaxed">
              TwiCa をご利用いただきありがとうございます。ベータ期間中にいただいた多くのバグ報告や機能要望を本リリースに反映させていただきました。十分な機能と安定性を確認できたため、本リリースをもって正式版とさせていただきます。
            </p>

          {/* 新機能 */}
          <section className="mb-10">
            <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
              新機能
            </h2>

            <div className="space-y-6">
              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  ガチャ履歴・統計ページ
                </h3>
                <p className="text-gray-400">
                  ガチャの履歴や統計情報をいつでも確認できるようになりました。配信者は自身のチャンネルでの視聴者ごとのガチャ履歴も閲覧でき、どのカードがどれくらい引かれているかを把握できます。
                </p>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  効果音の設定
                </h3>
                <p className="text-gray-400">
                  ガチャ演出に効果音を追加できるようになりました。配信者はダッシュボードからオリジナルの効果音ファイルをアップロードして設定できます。
                </p>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  Twitch チャット連携
                </h3>
                <p className="text-gray-400">
                  ガチャ結果を Twitch チャットに自動でアナウンスする機能を追加しました。視聴者がカードを引いた結果がチャットにも通知されるため、配信を盛り上げることができます。
                </p>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-3 text-lg font-semibold text-white">
                  マイコレクションの刷新
                </h3>
                <ul className="ml-4 list-disc space-y-2 text-gray-400">
                  <li>コレクションページが配信者一覧のサマリ表示に改善され、どの配信者のカードをどれだけ集めたか一目で確認可能に</li>
                  <li>配信者ごとのコレクションページを追加。ログイン後に直接アクセス可能</li>
                  <li>カード詳細ページを追加し、各カードの情報をじっくり閲覧可能に</li>
                </ul>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  複数チャンネルポイント報酬の設定
                </h3>
                <p className="text-gray-400">
                  1つのチャンネルで複数のチャンネルポイント報酬をガチャに割り当てられるようになりました。報酬ごとに異なるガチャ体験を提供できます。不要になった連携はいつでも解除できます。
                </p>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-3 text-lg font-semibold text-white">
                  オーバーレイのカスタマイズ強化
                </h3>
                <ul className="ml-4 list-disc space-y-2 text-gray-400">
                  <li>カード表示時間を自由に設定可能に</li>
                  <li>OBS ブラウザソース用 URL とコレクションページ URL を分離し、設定をわかりやすく改善</li>
                  <li>プレビュー機能を追加し、設定内容を事前に確認可能に</li>
                  <li>設定欄を折りたたみ可能にし、ページをすっきりと表示</li>
                  <li>OBS ブラウザソースとの互換性を向上させ、より安定した動作を実現</li>
                </ul>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-3 text-lg font-semibold text-white">
                  カード管理の改善
                </h3>
                <ul className="ml-4 list-disc space-y-2 text-gray-400">
                  <li>排出率の一括調整機能を追加（個別設定・レアリティ別の一括変更に対応）</li>
                  <li>縦長画像のアップロードに対応し、アスペクト比を選択可能に</li>
                  <li>カード一覧にレアリティ順を含む複数の並び替え方法に対応</li>
                  <li>カード説明文の展開表示に対応</li>
                </ul>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  投票キャンペーン機能
                </h3>
                <p className="text-gray-400">
                  ストレージ容量ボーナス付きの投票キャンペーン機能を追加しました。キャンペーンパネルの表示・非表示も視聴者側で制御できます。
                </p>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-3 text-lg font-semibold text-white">
                  その他の改善
                </h3>
                <ul className="ml-4 list-disc space-y-2 text-gray-400">
                  <li>ストレージ使用量の表示と使い方の説明を追加</li>
                  <li>モバイル表示でのボタンレイアウト改善</li>
                </ul>
              </div>
            </div>
          </section>

          {/* サービスの速度向上 */}
          <section className="mb-10">
            <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
              サービスの速度向上
            </h2>

            <div className="space-y-6">
              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  応答速度の改善
                </h3>
                <p className="text-gray-400">
                  サービスのホスティング基盤を刷新し、世界中からのアクセスがより速くなりました。
                </p>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  画像の自動最適化
                </h3>
                <p className="text-gray-400">
                  画像を自動的にリサイズ・WebP 変換する仕組みを導入しました。ページの読み込み速度が向上し、通信量も削減されます。
                </p>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-3 text-lg font-semibold text-white">
                  その他のパフォーマンス改善
                </h3>
                <ul className="ml-4 list-disc space-y-2 text-gray-400">
                  <li>チャンネルポイント引き換え時の処理を高速化</li>
                  <li>ページ読み込み時の不要な通信を抑制し、表示速度を改善</li>
                  <li>アプリケーション全体の軽量化を実施</li>
                </ul>
              </div>
            </div>
          </section>

          {/* 安定性の向上 */}
          <section className="mb-10">
            <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
              安定性の向上
            </h2>

            <div className="space-y-6">
              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  問題の早期発見・対応体制
                </h3>
                <p className="text-gray-400">
                  サービスで発生した問題を自動検知し、迅速に修正できる体制を整えました。
                </p>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-3 text-lg font-semibold text-white">
                  接続の安定性
                </h3>
                <ul className="ml-4 list-disc space-y-2 text-gray-400">
                  <li>オーバーレイのリアルタイム通信が安定し、不要な再接続を抑制</li>
                  <li>ログインセッションの有効期限を正しく処理し、予期しないログアウトを防止</li>
                  <li>チャンネルポイント連携のステータス管理を改善し、接続の信頼性が向上</li>
                </ul>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-3 text-lg font-semibold text-white">
                  データの信頼性
                </h3>
                <ul className="ml-4 list-disc space-y-2 text-gray-400">
                  <li>ガチャ実行中に問題が発生しても、データが中途半端な状態にならないよう改善</li>
                  <li>データ取得処理の安定性を向上し、一部で発生していたエラーを解消</li>
                </ul>
              </div>

              <div className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  ガチャ連続引き換えの安定化
                </h3>
                <p className="text-gray-400">
                  チャンネルポイントの連続引き換え時に処理が重なって不安定になる問題を修正しました。引き換えを順次実行する仕組みを導入し、連続でガチャを引いても正しく動作するようになりました。
                </p>
              </div>
            </div>
          </section>

          <div className="mt-12 rounded-xl bg-purple-900/30 border border-purple-700/50 p-6 text-center">
            <p className="text-gray-300">
              ベータ期間中にフィードバックをお寄せいただいた皆さまに、改めて感謝申し上げます。
            </p>
            <p className="mt-1 text-gray-300">
              今後も TwiCa をよろしくお願いいたします。
            </p>
          </div>
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
