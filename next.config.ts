import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

// Create next-intl plugin with custom request config path
// next-intlプラグインを作成（カスタムリクエスト設定パス指定）
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      // Allow any HTTPS host for external card images
      // Validation is done at API level (jpg/png extension only)
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

// Wrap with next-intl first, then Sentry
// next-intlを先に適用し、その後Sentryでラップ
export default withSentryConfig(withNextIntl(nextConfig), {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "azumaya",

  project: "twica",

  silent: false,

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Disable tunnel route to avoid conflicts
  tunnelRoute: undefined,

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: false,
    },
  },
});
