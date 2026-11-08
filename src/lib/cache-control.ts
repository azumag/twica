import { logger } from '@/lib/logger'

/**
 * Fail-closed Cache-Control directive for responses that must never be stored.
 *
 * This module is imported by `src/middleware.ts` and therefore must remain safe
 * for the Edge runtime. `@/lib/logger` is the shared isomorphic console logger
 * (no Node.js APIs), and the Workers Cache helpers below only touch the
 * standard `caches` global when invoked — middleware never calls them.
 */
export const PRIVATE_NO_STORE_CACHE_CONTROL = 'private, no-store'

// ---------------------------------------------------------------------------
// GET /api/streamer/[streamerId]/sound-settings の Workers Cache 契約 (#1334)
//
// - Cache-Tag / purge URL の生成を GET（発行側）と POST /api/streamer/settings
//   （無効化側）で共有し、タグ文字列の表記揺れによる purge 漏れを防ぐ。
// - 両側とも DB が返す正規化済み streamer `id`（小文字 UUID）だけを受け付ける。
//   path param から直接タグを作ると、大文字 UUID 等の別表記で GET された
//   キャッシュエントリへ正規 URL の delete が届かず purge 漏れする。
//
// purge 方式について:
// Workers ランタイムから Cache-Tag 指定の purge は呼べない。タグ purge は
// Cloudflare Zone API の機能で API トークンが必要であり、`cloudflare:workers`
// も OpenNext の route handler ビルドでは解決できない（app tsconfig の
// bundler resolution で Cannot find module）。このエンドポイントは
// ストリーマーごとに正規 URL が 1 本だけなので、`caches.default.delete()` の
// URL 削除で同等の無効化ができる。Cache-Tag は発行し続け、将来の Zone API
// purge や複数キー化への足掛かりとする。
// 制限: キャッシュキーは完全 URL（ホスト名を含む）なので、別ホスト名経由で
// 保存されたエントリにはこの削除が届かない。呼び出し側は request.url の
// origin から正規 URL を組み立て、公開ドメイン側の GET と一致させること。
// ---------------------------------------------------------------------------

const SOUND_SETTINGS_CACHE_TAG_PREFIX = 'sound-settings-'

/** DB が返した正規化済み streamer id から Cache-Tag を生成する。 */
export function soundSettingsCacheTag(streamerId: string): string {
  return `${SOUND_SETTINGS_CACHE_TAG_PREFIX}${streamerId}`
}

/**
 * Workers Cache の `caches.default` を、Node/ローカル実行でも安全に参照する。
 * ルート tsconfig は DOM lib の `caches`（CacheStorage）しか持たず
 * Cloudflare 固有の `.default` は型に無いため、ここで最小型を宣言する。
 */
interface WorkersCacheStorage {
  default?: {
    delete(request: string | URL | Request): Promise<boolean>
  }
}

function getWorkersDefaultCache(): WorkersCacheStorage['default'] {
  if (typeof caches === 'undefined') return undefined
  return (caches as unknown as WorkersCacheStorage).default
}

/**
 * 保存成功後の best-effort purge。失敗しても保存結果（HTTP 応答）へは
 * 影響させず、ログだけ残す（#1334: purge 失敗を設定保存の失敗へ昇格させない）。
 * Workers 以外の実行環境（vitest / next dev）では `caches` が無いため no-op。
 */
export async function purgeSoundSettingsCache(
  requestUrl: string,
  streamerId: string
): Promise<void> {
  const cache = getWorkersDefaultCache()
  if (!cache) return

  const cacheUrl = (() => {
    try {
      const { origin } = new URL(requestUrl)
      return `${origin}/api/streamer/${streamerId}/sound-settings`
    } catch {
      return undefined
    }
  })()
  if (!cacheUrl) return
  try {
    const deleted = await cache.delete(cacheUrl)
    logger.info('[cache-control] purged cached sound-settings GET', {
      cacheUrl,
      tag: soundSettingsCacheTag(streamerId),
      deleted,
    })
  } catch (error) {
    // purge 失敗時は s-maxage の自然失効に委ねる。設定保存自体は成功している
    // ため、ここで例外を呼び出し元へ返さない。
    logger.warn('[cache-control] sound-settings cache purge failed; relying on s-maxage expiry', {
      cacheUrl,
      tag: soundSettingsCacheTag(streamerId),
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
