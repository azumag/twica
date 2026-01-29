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

export default withNextIntl(nextConfig);
