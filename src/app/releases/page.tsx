import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import PublicFooter from "@/components/PublicFooter";

export const metadata: Metadata = {
  title: "リリースノート - TwiCa",
  description: "TwiCa の最新機能・改善内容をご確認ください。",
};

/**
 * リリースノートページ
 * 2026年7月: カードパック初リリース・パック別排出率・効果音詳細設定・発行枚数上限
 * v1.31.0: カード排出確率自動設定・コレクションコンプリート・ガチャ履歴フィルタ
 * v1.27.0: 支援特典システム・Twitchサブスク確認・問い合わせフォーム
 */
export default async function ReleasesPage() {
  const session = await getSession();
  const tHeader = await getTranslations("header");
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

          {/* 2026年7月 - 初リリース機能を支援機能/通常機能で分類し、同じ機能群の改善をまとめて説明 */}
          <div className="mb-16">
            <div className="mb-8">
              <div className="mb-2 inline-block rounded-full bg-purple-600 px-3 py-1 text-sm font-medium text-white">
                2026年7月アップデート
              </div>
              <p className="mt-2 text-sm text-gray-500">2026-07-03</p>
            </div>

            <p className="mb-10 leading-relaxed text-gray-400">
              今回のアップデートでは、カードパック機能を初リリースしました。
              チャネルポイント報酬ごとに抽選対象を分けられるようになり、
              支援機能としてパックの追加登録や効果音の詳細設定も利用できます。
            </p>

            <section className="mb-10">
              <h2 className="mb-6 border-b border-gray-700 pb-3 text-2xl font-bold text-white">
                支援機能
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    カードパックの追加登録
                  </h3>
                  <p className="text-gray-400">
                    支援プランまたはTwitchサブスクが有効な配信者は、カードパックを追加登録できるようになりました。
                    登録したパックはカード作成やチャネルポイント報酬設定でプルダウンから選べるため、
                    パック名の入力ミスを防ぎながら運用できます。
                  </p>
                  <p className="mt-3 text-gray-400">
                    既に登録済みのパックの利用・解除は、支援状態が変わっても行えます。
                    パック名のリネーム、デフォルトパック名の変更、パック別のカード一覧表示にも対応しました。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    ガチャ効果音の詳細設定
                  </h3>
                  <p className="text-gray-400">
                    ガチャ効果音を、全体・レアリティ別・チャネルポイント報酬別に設定できるようになりました。
                    報酬別設定では、報酬IDを手入力するのではなく、報酬名と必要ポイントが分かるプルダウンから選択できます。
                  </p>
                  <p className="mt-3 text-gray-400">
                    複数枚ガチャでは、引いたカード全体を見て、より適切な効果音が選ばれるようになりました。
                    保存後の設定反映や、許可される効果音URLの扱いも改善しています。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    支援特典ページの更新
                  </h3>
                  <p className="text-gray-400">
                    支援特典ページを今回の内容に合わせて更新しました。
                    カードパックの追加登録やガチャ効果音の詳細設定など、
                    利用できる特典内容を確認しやすくしています。
                  </p>
                </div>
              </div>
            </section>

            <section className="mb-10">
              <h2 className="mb-6 border-b border-gray-700 pb-3 text-2xl font-bold text-white">
                通常機能
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    報酬ごとのカードパック抽選
                  </h3>
                  <p className="text-gray-400">
                    チャネルポイント報酬ごとに、抽選対象となるカードパックを切り替えられるようになりました。
                    通常報酬では全カード、特別な報酬では特定パックのみ、といった使い分けができます。
                  </p>
                  <p className="mt-3 text-gray-400">
                    未指定の場合はこれまで通り全カードが対象です。
                    未分類カードだけを対象にするデフォルトパックも選択できます。
                    パック未登録時には不要な選択欄を表示しないなど、設定画面の分かりやすさも改善しました。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    パック別排出率設定
                  </h3>
                  <p className="text-gray-400">
                    ガチャの自動モードで、全体共通のレアリティ配分に加えて、
                    パックごとのレアリティ配分を設定できるようになりました。
                    個別設定がないパックは全体設定を引き継ぐため、必要なパックだけ調整できます。
                  </p>
                  <p className="mt-3 text-gray-400">
                    パック指定の抽選では、そのパック内のカード構成とレアリティ配分をもとに抽選されます。
                    カード一覧や作成・編集画面に表示される確率も、実際の抽選対象に近い内容になるよう改善しました。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    パック別コレクション表示
                  </h3>
                  <p className="text-gray-400">
                    視聴者向けコレクションページで、カードパックごとの絞り込みとコンプリート達成表示に対応しました。
                    全体の収集状況だけでなく、特定パックごとの進捗や達成状況も確認できます。
                  </p>
                  <p className="mt-3 text-gray-400">
                    達成日時の表示で発生していた画面表示の不一致も修正しました。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    発行枚数上限
                  </h3>
                  <p className="text-gray-400">
                    カードごとに発行上限を設定できるようになりました。
                    限定カードや先着カードのように、配布枚数を制限したい運用に対応できます。
                  </p>
                  <p className="mt-3 text-gray-400">
                    上限に達したカードが抽選された場合は、可能な範囲で別カードを再抽選します。
                    上限到達と設定不備も区別して扱うようになりました。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    アニメーションGIF対応
                  </h3>
                  <p className="text-gray-400">
                    カード画像としてアニメーションGIFを保持できるようになりました。
                    一般的なGIF形式を正しく判定し、GIF利用時のサイズ上限も画面上で分かりやすく案内します。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    設定画面の整理
                  </h3>
                  <p className="text-gray-400">
                    カード引き換え設定の詳細モードを、
                    接続状況・メイン報酬・追加の引き換え設定・レイドガチャに整理しました。
                    機能はそのままに、設定内容を見つけやすくしています。
                  </p>
                </div>
              </div>
            </section>
          </div>

          {/* v1.31.0 - カード排出確率自動設定・コレクションコンプリート・ガチャ履歴フィルタ */}
          <div className="mb-16">
            <div className="mb-8">
              <div className="mb-2 inline-block rounded-full bg-purple-600 px-3 py-1 text-sm font-medium text-white">
                v1.31.0
              </div>
              <p className="mt-2 text-sm text-gray-500">2026-03-04</p>
            </div>

            {/* カード排出確率の自動設定機能 */}
            <section className="mb-10">
              <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
                カード排出確率の自動設定機能
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    概要
                  </h3>
                  <p className="text-gray-400">
                    レアリティごとに目標確率を設定するだけで、各カードの排出確率が自動計算されるようになりました。カードの追加・削除時も自動で再計算されるため、手動での調整が不要になります。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    レアリティ内の偏り設定
                  </h3>
                  <p className="text-gray-400">
                    同じレアリティのカード間で「出やすさ」に差をつけることができます。各カードの確率プレビューで設定結果を確認でき、「?」アイコンから詳しいヘルプも参照できます。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    互換性
                  </h3>
                  <p className="text-gray-400">
                    既存の手動設定はそのまま維持されます。自動設定モードと手動モードはいつでも切り替え可能です。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-3 text-lg font-semibold text-white">
                    既知の制限事項
                  </h3>
                  <ul className="ml-4 list-disc space-y-2 text-gray-400">
                    <li>メタデータ編集時に不要な再計算が発生する場合があります（最適化予定）</li>
                    <li>初回保存が失敗した場合の復旧手順が煩雑です（リトライ機構を追加予定）</li>
                  </ul>
                </div>
              </div>
            </section>

            {/* コレクションコンプリート機能 */}
            <section className="mb-10">
              <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
                コレクションコンプリート機能
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    概要
                  </h3>
                  <p className="text-gray-400">
                    コレクションの達成度を確認できるようになりました。全カードを集めるとゴールドの勲章が表示されます。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    過去履歴
                  </h3>
                  <p className="text-gray-400">
                    コンプリート達成の記録は永続的に保存されます。配信者がカード枚数を変更した後も、過去の達成記録はそのまま残ります。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    ⚠️ 注意事項
                  </h3>
                  <p className="text-gray-400">
                    コンプリート達成はコレクションページを確認したタイミングで記録されます。ページを開かない限り、達成判定は行われません。
                  </p>
                </div>

                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    配信者向け
                  </h3>
                  <p className="text-gray-400">
                    ガチャ履歴のユーザー別ページから、各視聴者のコレクションコンプリート状況を確認できます。
                  </p>
                </div>
              </div>
            </section>

            {/* ガチャ履歴フィルタ追加 */}
            <section className="mb-10">
              <h2 className="mb-6 text-2xl font-bold text-white border-b border-gray-700 pb-3">
                ガチャ履歴フィルタ追加
              </h2>

              <div className="space-y-6">
                <div className="rounded-xl bg-gray-800 p-6">
                  <h3 className="mb-2 text-lg font-semibold text-white">
                    登録カードから検索できるフィルタ
                  </h3>
                  <p className="text-gray-400">
                    ガチャ履歴ページに、登録されているカードから絞り込み検索ができるフィルタ機能を追加しました。特定のカードの排出履歴を簡単に確認できます。
                  </p>
                </div>
              </div>
            </section>
          </div>

          {/* v1.27.0 - 支援特典・Twitchサブスク確認・問い合わせフォーム */}
          <div className="mb-16">
            <div className="mb-8">
              <div className="mb-2 inline-block rounded-full bg-gray-600 px-3 py-1 text-sm font-medium text-white">
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
                    <li><span className="text-purple-400 font-medium">Twitchサブスク特典</span> - <a href="https://www.twitch.tv/azumagbanjo" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">作者：あずまぐ（@azumagbanjo）の Twitch チャネル</a>をサブスクしている方に自動適用（ご贔屓同等の特典）</li>
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
                    Twitch チャネルサブスクによる特典自動適用
                  </h3>
                  <p className="text-gray-400">
                    <a href="https://www.twitch.tv/azumagbanjo" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300 underline">作者：あずまぐ（@azumagbanjo）の Twitch チャネル</a>をサブスクライブしている方は、アカウント設定の「Twitchサブスク確認」からサブスク状態を確認するだけで、ご贔屓同等の特典が自動適用されます。支援コードの入力は不要です。
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
                  ガチャの履歴や統計情報をいつでも確認できるようになりました。配信者は自身のチャネルでの視聴者ごとのガチャ履歴も閲覧でき、どのカードがどれくらい引かれているかを把握できます。
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
                  複数チャネルポイント報酬の設定
                </h3>
                <p className="text-gray-400">
                  1つのチャネルで複数のチャネルポイント報酬をガチャに割り当てられるようになりました。報酬ごとに異なるガチャ体験を提供できます。不要になった連携はいつでも解除できます。
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
                  <li>チャネルポイント引き換え時の処理を高速化</li>
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
                  <li>チャネルポイント連携のステータス管理を改善し、接続の信頼性が向上</li>
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
                  チャネルポイントの連続引き換え時に処理が重なって不安定になる問題を修正しました。引き換えを順次実行する仕組みを導入し、連続でガチャを引いても正しく動作するようになりました。
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

      <PublicFooter />
    </div>
  );
}
