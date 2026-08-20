/**
 * Cloudflare KV binding 取得ヘルパー（r2-client.ts の R2BucketLike パターン踏襲）。
 *
 * RATE_LIMIT_KV は wrangler.toml で prod/preview の両方に宣言済み（レート制限・
 * maintenance EventSub parking・短命OBSデモイベントとキーprefixで分離して共有）。
 * ローカル（next dev）ではバインディングが無いため null を返し、呼び出し側が
 * メモリキャッシュ等へフォールバックする。
 */

/**
 * Cloudflare KV の `expirationTtl` に指定できる最小値（秒）。これを下回る値を
 * PUT すると `400 Invalid expiration_ttl` で拒否される。呼び出し側は自身の
 * TTL計算（切り上げ/切り捨てなど丸め方は用途により異なる）の結果をこの定数で
 * クランプすること（例: rate-limit.ts, twitch/app-token.ts）。
 * 参照: https://developers.cloudflare.com/kv/api/write-key-value-pairs/
 */
export const KV_MIN_EXPIRATION_TTL_SECONDS = 60

/** Cloudflare Workers KV API の最小インターフェース（tsconfig に型を要求しない）。 */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Workers 環境から KV バインディングを取得する。Workers 以外では null。
 * getCloudflareContext はビルド時に @opennextjs/cloudflare を解決しないよう
 * 動的 import する（r2-client.ts と同じ理由）。
 */
export async function getKvBinding(
  bindingName = "RATE_LIMIT_KV",
): Promise<KVNamespaceLike | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare")
    const ctx = await getCloudflareContext({ async: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binding = (ctx.env as any)[bindingName] as KVNamespaceLike | undefined
    return binding ?? null
  } catch {
    return null
  }
}
