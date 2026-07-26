import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import PublicFooter from "@/components/PublicFooter";

export const metadata: Metadata = {
  title: "FAQ - TwiCa",
  description: "Frequently asked questions about TwiCa for viewers and streamers.",
};

// 各配列の要素は messages の faqPage.<scope>.<key> と1対1で対応する（表示順もこの順）
const viewerQuestions = ["login", "collection", "missingCards"] as const;
const streamerQuestions = ["affiliate", "enableStreamer", "setup", "overlay", "cards"] as const;
const troubleQuestions = [
  "eventsub",
  "channelPointsUnavailable",
  "capabilityLost",
  "imageUpload",
  "support",
] as const;

export default async function FaqPage() {
  const session = await getSession();
  const t = await getTranslations("faqPage");
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
        <h1 className="mb-4 text-3xl font-bold text-white">
          {t("title")}
        </h1>
        <p className="mb-10 text-gray-400">
          {t("intro")}
        </p>

        <FaqSection title={t("viewer.title")} keys={viewerQuestions} scope="viewer" t={t} />
        <FaqSection title={t("streamer.title")} keys={streamerQuestions} scope="streamer" t={t} />
        <FaqSection title={t("trouble.title")} keys={troubleQuestions} scope="trouble" t={t} />

        <section className="rounded-xl bg-gray-800 p-6">
          <h2 className="mb-3 text-xl font-semibold text-white">
            {t("contact.title")}
          </h2>
          <p className="text-gray-400">
            {t("contact.description")}
            <Link href="/about" className="text-purple-400 hover:text-purple-300">
              {t("contact.aboutLink")}
            </Link>
            {t("contact.descriptionEnd")}
          </p>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

type FaqSectionProps = {
  title: string;
  keys: readonly string[];
  scope: "viewer" | "streamer" | "trouble";
  t: Awaited<ReturnType<typeof getTranslations>>;
};

function FaqSection({ title, keys, scope, t }: FaqSectionProps) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-2xl font-semibold text-purple-400">
        {title}
      </h2>
      <div className="space-y-4">
        {keys.map((key) => (
          <article key={key} className="rounded-xl bg-gray-800 p-6">
            <h3 className="mb-3 text-lg font-semibold text-white">
              {t(`${scope}.${key}.question`)}
            </h3>
            <p className="text-gray-400">
              {t(`${scope}.${key}.answer`)}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
