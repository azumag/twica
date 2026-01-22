import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "About - TwiCa",
  description: "TwiCa operator information, contact details, and support options.",
};

/**
 * About page showing operator information and contact details
 * 運営者情報と連絡先を表示するページ
 */
export default async function AboutPage() {
  const session = await getSession();
  const t = await getTranslations("aboutPage");
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
              <Link
                href="/"
                className="text-gray-400 hover:text-white"
              >
                {tGuidePage("home")}
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <h1 className="mb-8 text-3xl font-bold text-white">
          {t("title")}
        </h1>

        {/* Operator info section */}
        {/* 運営者情報セクション */}
        <section className="mb-8 rounded-xl bg-gray-800 p-6">
          <h2 className="mb-4 text-xl font-semibold text-white">
            {t("operator.title")}
          </h2>
          <p className="text-gray-400">
            {t("operator.name")}
          </p>
        </section>

        {/* SNS links section */}
        {/* SNSリンクセクション */}
        <section className="mb-8 rounded-xl bg-gray-800 p-6">
          <h2 className="mb-4 text-xl font-semibold text-white">
            {t("contact.title")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {/* X (Twitter) */}
            <a
              href="https://x.com/azumag"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-lg bg-gray-700 p-4 transition-colors hover:bg-gray-600"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-black">
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-white">X (Twitter)</p>
                <p className="text-sm text-gray-400">@azumag</p>
              </div>
            </a>

            {/* Bluesky */}
            <a
              href="https://bsky.app/profile/azumag.bsky.social"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-lg bg-gray-700 p-4 transition-colors hover:bg-gray-600"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500">
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 01-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-white">Bluesky</p>
                <p className="text-sm text-gray-400">@azumag.bsky.social</p>
              </div>
            </a>

            {/* Twitch */}
            <a
              href="https://www.twitch.tv/azumagbanjo"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-lg bg-gray-700 p-4 transition-colors hover:bg-gray-600"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-600">
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-white">Twitch</p>
                <p className="text-sm text-gray-400">azumagbanjo</p>
              </div>
            </a>

            {/* GitHub */}
            <a
              href="https://github.com/azumag"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-lg bg-gray-700 p-4 transition-colors hover:bg-gray-600"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-900">
                <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-white">GitHub</p>
                <p className="text-sm text-gray-400">azumag</p>
              </div>
            </a>
          </div>
        </section>

        {/* Support section */}
        {/* 支援セクション */}
        <section className="mb-8 rounded-xl bg-gray-800 p-6">
          <h2 className="mb-4 text-xl font-semibold text-white">
            {t("support.title")}
          </h2>
          <p className="mb-4 text-gray-400">
            {t("support.description")}
          </p>
          <a
            href="https://ofuse.me/8fe1bedb"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-3 rounded-lg bg-gradient-to-r from-pink-500 to-orange-400 px-6 py-3 font-medium text-white transition-opacity hover:opacity-90"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
            {t("support.button")}
          </a>
        </section>

        {/* About TwiCa section */}
        {/* TwiCaについてセクション */}
        <section className="rounded-xl bg-gray-800 p-6">
          <h2 className="mb-4 text-xl font-semibold text-white">
            {t("about.title")}
          </h2>
          <p className="text-gray-400">
            {t("about.description")}
          </p>
        </section>
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
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
