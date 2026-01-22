import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ErrorBoundary } from "@/components/ErrorBoundary";
// Vercel Analytics - ユーザー行動とパフォーマンスデータを収集してVercel Dashboardで可視化
import { Analytics } from "@vercel/analytics/next";
// next-intl - 国際化サポートのプロバイダーとサーバーサイドユーティリティ
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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

  return (
    <html lang={locale}>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* i18n Provider - provides translations to all client components */}
        {/* i18nプロバイダー - 全クライアントコンポーネントに翻訳を提供 */}
        <NextIntlClientProvider messages={messages}>
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </NextIntlClientProvider>
        {/* Vercel Analytics: ページビューとWeb Vitalsを自動収集 */}
        <Analytics />
      </body>
    </html>
  );
}
