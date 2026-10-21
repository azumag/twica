import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import PublicFooter from "@/components/PublicFooter";

export const metadata: Metadata = {
  title: "Card Trading Guide - TwiCa",
  description: "How to use TwiCa card trading: regular listings, auctions and streamer settings.",
};

// 各配列の要素はメッセージ側の tradeGuidePage.<セクション>.<キー> と1対1で対応し、
// 配列の順序が表示順。番号付きカードの描画経路を StepList 1箇所に集約し、カード番号を
// 配列順（index + 1）から導出することで、手順を途中に挿入しても番号がズレないようにしている
// （/guide と同じ方針）。手順を増減するときは、この配列とメッセージ（ja/en 両方）を
// 更新する必要があり、tests/unit/public-help-pages.test.ts の同期テストが一致を強制する。
//
// このページは /guide（本番ではトレード入口がまだ非表示）からはリンクしない。
// トレード画面共通の layout（src/app/trade/layout.tsx）にだけ「使い方」リンクを置く。
const overviewSteps = ["what", "where", "login", "unavailable"] as const;
const offerSteps = ["create", "accept", "quantity", "cancel", "limit", "cross"] as const;
const auctionSteps = [
  "create",
  "bid",
  "change",
  "select",
  "expire",
  "withdrawLock",
  "cancel",
  "limits",
] as const;
const streamerSteps = ["enable", "cross", "wantable", "visibility"] as const;
const faqItems = [
  "disabled",
  "cardInactive",
  "alreadyDone",
  "notEnough",
  "limitReached",
  "alreadyListed",
  "noPartner",
  "notWantable",
  "bidUnsettleable",
  "selectionExpired",
] as const;

// ページ内の見出しへ飛ぶ目次。ラベルは各セクションの title をそのまま使う
// （目次専用の文言を持たないので、見出しと目次の表記が食い違わない）。
const sectionIds = ["overview", "offer", "auction", "streamer", "faq"] as const;

// サブ手順（ステップ内の番号付き操作列）を持つステップと、その substep キー。
// 番号付き手順を description 内の "1. 2. 3." というテキストで表すと、スクリーン
// リーダーがリストとして読み上げず、狭い幅で項目が折り返したときに項目境界も
// 視覚的に消える。該当ステップだけ実際の <ol> として描画する（/guide と同じ理由）。
const stepSubsteps: Record<string, readonly string[]> = {
  "offer.create": ["substep1", "substep2", "substep3", "substep4"],
  "auction.create": ["substep1", "substep2", "substep3", "substep4"],
  "auction.select": ["substep1", "substep2", "substep3"],
};

// 補足項目（順序に意味のない箇条書き）を持つステップと、その point キー。
// 手順ではなく「ルール・条件」の列挙なので、番号を振らず <ul> で描画する。
const stepPoints: Record<string, readonly string[]> = {
  "overview.where": ["point1", "point2", "point3"],
  "offer.accept": ["point1", "point2", "point3"],
  "offer.cross": ["point1", "point2", "point3"],
  "auction.bid": ["point1", "point2", "point3", "point4", "point5"],
  "auction.limits": ["point1", "point2", "point3"],
  "streamer.enable": ["point1", "point2"],
  "streamer.wantable": ["point1", "point2", "point3"],
  "streamer.visibility": ["point1", "point2", "point3"],
};

/**
 * Guide page explaining how to use card trading (regular listings and auctions)
 * カードトレード（通常出品・オークション）の使い方を説明するガイドページ。
 * ログイン不要で表示できる（/guide と同じ公開ページ）。
 */
export default async function TradeGuidePage() {
  const session = await getSession();
  const t = await getTranslations("tradeGuidePage");
  const tHeader = await getTranslations("header");
  const tGuide = await getTranslations("guidePage");

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
              <Link
                href="/"
                className="text-gray-400 hover:text-white"
              >
                {tGuide("home")}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <h1 className="mb-4 text-3xl font-bold text-white">
          {t("title")}
        </h1>
        <p className="mb-6 text-gray-400">
          {t("lead")}
        </p>

        {/* Table of contents */}
        {/* 目次 - 長いページなので各セクションへのアンカーを並べる */}
        <nav aria-label={t("title")} className="mb-10 flex flex-wrap gap-2">
          {sectionIds.map((id) => (
            <a
              key={id}
              href={`#${id}`}
              className="rounded-full border border-gray-600 bg-gray-800 px-3 py-1 text-sm text-gray-300 hover:bg-gray-700"
            >
              {t(`${id}.title`)}
            </a>
          ))}
        </nav>

        {/* Getting started section */}
        {/* はじめにセクション */}
        <section id="overview" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("overview.title")}
          </h2>

          <StepList scope="overview" steps={overviewSteps} t={t} />
        </section>

        {/* Regular trade section */}
        {/* 通常トレードセクション */}
        <section id="offer" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("offer.title")}
          </h2>
          <p className="mb-6 text-gray-400">
            {t("offer.lead")}
          </p>

          <StepList scope="offer" steps={offerSteps} t={t} />
        </section>

        {/* Auction section */}
        {/* オークションセクション */}
        <section id="auction" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("auction.title")}
          </h2>
          <p className="mb-6 text-gray-400">
            {t("auction.lead")}
          </p>

          <StepList scope="auction" steps={auctionSteps} t={t} />
        </section>

        {/* For streamers section */}
        {/* 配信者向けセクション */}
        <section id="streamer" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("streamer.title")}
          </h2>
          <p className="mb-6 text-gray-400">
            {t("streamer.requirement")}
          </p>

          <StepList scope="streamer" steps={streamerSteps} t={t} />
        </section>

        {/* FAQ section */}
        {/* よくある質問（取引が失敗する主な理由と対処） */}
        <section id="faq" className="scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("faq.title")}
          </h2>

          <div className="space-y-4">
            {faqItems.map((item) => (
              <div key={item} className="rounded-xl bg-gray-800 p-6">
                <h3 className="mb-2 text-lg font-semibold text-white">
                  {t(`faq.${item}.question`)}
                </h3>
                <p className="text-gray-400">
                  {t(`faq.${item}.answer`)}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

type StepListProps = {
  scope: "overview" | "offer" | "auction" | "streamer";
  steps: readonly string[];
  t: Awaited<ReturnType<typeof getTranslations>>;
};

/**
 * 番号付きの手順カード一覧。
 * 番号は配列順（index + 1）から導出するため、手順の増減でズレない。
 */
function StepList({ scope, steps, t }: StepListProps) {
  return (
    <div className="space-y-6">
      {steps.map((step, index) => {
        const substeps = stepSubsteps[`${scope}.${step}`];
        const points = stepPoints[`${scope}.${step}`];

        return (
          <div key={step} className="rounded-xl bg-gray-800 p-6">
            <div className="mb-3 flex items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-600 text-sm font-bold text-white">
                {index + 1}
              </span>
              <h3 className="text-lg font-semibold text-white">
                {t(`${scope}.${step}.title`)}
              </h3>
            </div>
            <p className="text-gray-400">
              {t(`${scope}.${step}.description`)}
            </p>
            {substeps && (
              <ol className="mt-3 list-decimal space-y-2 pl-6 text-gray-400">
                {substeps.map((substep) => (
                  <li key={substep}>{t(`${scope}.${step}.${substep}`)}</li>
                ))}
              </ol>
            )}
            {points && (
              <ul className="mt-3 space-y-2 text-gray-400">
                {points.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <span className="text-purple-400">•</span>
                    <span>{t(`${scope}.${step}.${point}`)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
