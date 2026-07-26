import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import PublicFooter from "@/components/PublicFooter";

export const metadata: Metadata = {
  title: "Guide - TwiCa",
  description: "TwiCa usage guide for viewers and streamers.",
};

// 各配列の要素はメッセージ側の step<n> / tip<n> キーと1対1で対応し、配列の順序が表示順。
// 番号付きカードの描画経路を StepList 1箇所に集約することで、カード番号を配列順
// （index + 1）から導出し、手順を途中に挿入しても番号がズレないようにしている。
// 手順を増減するときは、この配列とメッセージの両方を更新する必要があり、
// tests/unit/public-help-pages.test.ts の同期テストが両者の一致を強制する。
const viewerSteps = ["step1", "step2", "step3", "step4"] as const;
const streamerSteps = [
  "step1",
  "step2",
  "step3",
  "step4",
  "step5",
  "step6",
] as const;
const tips = ["tip1", "tip2", "tip3", "tip4", "tip5", "tip6"] as const;

// サブ手順（ステップ内の番号付き操作列）を持つステップと、その substep キー。
// 番号付き手順を description 内の "1. 2. 3." というテキストで表すと、スクリーン
// リーダーがリストとして読み上げず、狭い幅で項目が折り返したときに hanging indent が
// 無いため項目境界も視覚的に消える。該当ステップだけ実際の <ol> として描画する。
const stepSubsteps: Record<string, readonly string[]> = {
  "streamer.step2": ["substep1", "substep2", "substep3"],
};

/**
 * Guide page explaining how to use TwiCa
 * TwiCaの使い方を説明するガイドページ
 */
export default async function GuidePage() {
  const session = await getSession();
  const t = await getTranslations("guidePage");
  const tHeader = await getTranslations("header");

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
                {t("home")}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <h1 className="mb-8 text-3xl font-bold text-white">
          {t("title")}
        </h1>

        {/* For viewers section */}
        {/* 視聴者向けセクション - id="viewer" でトップページからリンク可能 */}
        <section id="viewer" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("viewer.title")}
          </h2>

          <StepList scope="viewer" steps={viewerSteps} t={t} />
        </section>

        {/* For streamers section */}
        {/* 配信者向けセクション - id="streamer" でトップページからリンク可能 */}
        <section id="streamer" className="mb-12 scroll-mt-8">
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("streamer.title")}
          </h2>
          <p className="mb-6 text-gray-400">
            {t("streamer.requirement")}
          </p>

          <StepList scope="streamer" steps={streamerSteps} t={t} />
        </section>

        {/* Tips section */}
        {/* ヒントセクション */}
        <section>
          <h2 className="mb-6 text-2xl font-semibold text-purple-400">
            {t("tips.title")}
          </h2>

          <div className="rounded-xl bg-gray-800 p-6">
            <ul className="space-y-3 text-gray-400">
              {tips.map((tip) => (
                <li key={tip} className="flex items-start gap-2">
                  <span className="text-purple-400">•</span>
                  {t(`tips.${tip}`)}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

type StepListProps = {
  scope: "viewer" | "streamer";
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
          </div>
        );
      })}
    </div>
  );
}
