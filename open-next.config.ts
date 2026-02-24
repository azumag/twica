import type { OpenNextConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext configuration for Cloudflare Workers
 * Cloudflare Workers用のOpenNext設定
 *
 * This configuration file controls how the Next.js app is deployed
 * to Cloudflare Workers using OpenNext.
 *
 * この設定ファイルはOpenNextを使用してNext.jsアプリを
 * Cloudflare Workersにデプロイする方法を制御します。
 */
const config: OpenNextConfig = {
  default: {
    override: {
      wrapper: "cloudflare-node",
      converter: "edge",
      proxyExternalRequest: "fetch",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "direct",
    },
  },
  // Allow Node.js crypto in edge runtime
  // EdgeランタイムでNode.js cryptoを許可
  edgeExternals: ["node:crypto"],
  middleware: {
    external: true,
    override: {
      wrapper: "cloudflare-edge",
      converter: "edge",
      proxyExternalRequest: "fetch",
      incrementalCache: "dummy",
      tagCache: "dummy",
      queue: "direct",
    },
  },
};

export default config;
