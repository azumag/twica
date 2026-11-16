import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { ErrorBoundary } from "@/components/ErrorBoundary";
// next-intl - 国際化サポートのプロバイダーとサーバーサイドユーティリティ
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { headers } from "next/headers";
import { pick, ROOT_CLIENT_NAMESPACES } from "@/i18n/client-namespaces";

export const metadata: Metadata = {
  title: "TwiCa - Twitch Channel Point Trading Cards",
  description: "チャネルポイントでカードガチャを引けるサービス",
};

/**
 * Root Layout with i18n support
 * ロケールを検出してNextIntlClientProviderでラップする
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Get current locale from server-side detection (cookie/header)
  // サーバーサイドでロケールを検出（Cookie/ヘッダーから）
  const locale = await getLocale();
  const messages = await getMessages();
  // #836 項目5: middleware がリクエストごとに発行した CSP nonce を参照する。
  // Script コンポーネントへ nonce を渡すことで、CSP の script-src を
  // 'unsafe-inline' から nonce ベースへ移行しても Cloudflare Insights を読み込める。
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang={locale}>
      <body className="antialiased">
        {/* i18n Provider - provides translations to all client components */}
        {/* i18nプロバイダー - 全クライアントコンポーネントに翻訳を提供 */}
        {/*
          * Root layout は全ルートを包むため、ここで全 namespace を渡すと
          * 55 namespace / 約134KB が毎ページの client payload に乗ってしまう。
          * 各セグメントの layout が自分の NextIntlClientProvider を持つため、
          * root は「自前の provider を持たないルート」ぶんだけを渡す。
          *
          * messages prop は決して省略しない: 省略すると next-intl の
          * NextIntlClientProviderServer が getMessages() を呼び、全 namespace を
          * 送ってしまう（プロバイダーは階層ごとに messages を「置換」するので、
          * 親の list を暗黙に継承させる設計にもしない）。
          */}
        <NextIntlClientProvider messages={pick(messages, ROOT_CLIENT_NAMESPACES)}>
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </NextIntlClientProvider>
        {/* Cloudflare Web Analytics: ページビューを自動収集
            環境変数NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKENが設定されている場合のみ有効 */}
        {process.env.NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN && (
          <Script
            defer
            nonce={nonce}
            src="https://static.cloudflareinsights.com/beacon.min.js"
            data-cf-beacon={`{"token": "${process.env.NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN}"}`}
          />
        )}
      </body>
    </html>
  );
}
