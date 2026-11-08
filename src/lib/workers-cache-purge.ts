import { logger } from "@/lib/logger.server";

/**
 * Workers Cache の Cache-Tag を best-effort で purge する（Issue #1334）。
 *
 * - OpenNext + Cloudflare Workers では `cloudflare:workers` の `cache.purge` が使えるが、
 *   Next.js route handler は `ctx` を受け取らないため import 形式が必須。
 * - `cloudflare:workers` は Workers ランタイム固有モジュールのため、ローカル dev や
 *   Node 上のテストでは解決できない。dynamic import を try/catch し、失敗時はログのみ
 *   で呼び出し元の保存処理を失敗させない（purge は付随処理であり、DB 保存の成否に
 *   影響させてはならない）。
 * - tag は DB が返す正規化済み streamer id から生成した値を渡すこと（UUID 表記揺れで
 *   purge 漏れしないようにする。公開 GET 側も同じ正規化済み id をタグに使う）。
 */
export async function purgeCacheTagsBestEffort(tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  try {
    // Workers ランタイム固有モジュール。Node/test 環境では解決できないため
    // dynamic import + try/catch で best-effort に扱う。specifier を変数化し
    // @vite-ignore を付けることで、Vitest/Vite の import-analysis が解決を試みて
    // テスト収集を壊すのを防ぐ（Workers ランタイムでは実モジュールが存在する）。
    const specifier = "cloudflare:workers";
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      cache?: {
        purge?: (opts: { tags: string[] }) => Promise<{ success: boolean; errors?: unknown[] }>;
      };
    };
    const cache = mod?.cache;
    if (!cache || typeof cache.purge !== "function") {
      logger.debug("workers-cache-purge: cache.purge unavailable, skipping", { tags });
      return;
    }
    const result = await cache.purge({ tags });
    if (!result?.success) {
      logger.warn("workers-cache-purge: purge reported failure", { tags, errors: result?.errors });
    }
  } catch (error) {
    // Workers 以外の実行環境、または purge API の一時失敗。保存成功後の付随処理
    // なので warn ログのみとし、呼び出し元へは伝播させない。
    logger.warn("workers-cache-purge: purge skipped/failed", {
      tags,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
