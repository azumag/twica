/**
 * EventSub 通知のリプレイ（重複配信）防止 / issue #836
 *
 * Twitch は EventSub 通知を再送する場合があり、受信側に 10 分窓のタイムスタンプ検証と
 * message-id の重複排除を要求する（Twitch 公式仕様）。本モジュールは KV ベースの
 * message-id 重複排除を提供する。
 *
 * 設計の考え方:
 * - キー: `eventsub:dedup:${messageId}`、TTL 10 分（Twitch の再送窓と同じ）
 * - 重複判定（isDuplicateEventSubMessage）と記録（markEventSubMessageSeen）は分離し、
 *   記録は「処理が完了した（2xx を返す）」時点で呼び出す。処理失敗（503 を返す）時に
 *   記録済みだと、Twitch が同一 message-id で再送してきた際に重複と誤判定され、
 *   ガチャ未実行のまま通知が永久喪失するため（route 側のコメント参照）。
 * - KV 取得に失敗した場合はフェイルオープン（重複と誤判定して通知を落とさない）。
 *   二重付与は DB 層（gacha_history.event_id UNIQUE + ON CONFLICT DO NOTHING）で
 *   完全に閉じているため、KV 障害時に既知と誤判定するリスクの方が大きい。
 * - 適用対象は notification / revocation のみ。verification は同一 message-id の
 *   再送時に challenge を返し直すのが正しく、重複排除すると購読確立を壊しうる。
 */
import type { KVNamespaceLike } from '@/lib/maintenance/eventsub-park'

const DEDUP_KV_BINDING_NAME = 'RATE_LIMIT_KV'
const DEDUP_TTL_SECONDS = 10 * 60 // Twitch の再送窓（10分）

/**
 * Cloudflare Workers 環境から KV バインディングを取得する。
 * Workers 外の環境（next dev / Node / テスト）では null（= フェイルオープン）。
 * eventsub-park.ts の getMaintenanceKvBinding と同じフォールバックパターン。
 */
async function getDedupKvBinding(): Promise<KVNamespaceLike | null> {
  try {
    // ローカル開発時に @opennextjs/cloudflare をバンドルしないよう動的 import
    // （db/client.ts, r2-client.ts と同じ理由）
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env } = await getCloudflareContext({ async: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binding = (env as any)[DEDUP_KV_BINDING_NAME] as KVNamespaceLike | undefined
    return binding ?? null
  } catch {
    // Cloudflare Workers 環境ではない（next dev / Node / テスト）
    return null
  }
}

/**
 * message-id が既知（10分以内に受信・処理完了済み）かどうかを判定する。
 * 記録（markEventSubMessageSeen）とは分離されており、この関数は読み取りのみ。
 *
 * @param messageId twitch-eventsub-message-id ヘッダー値
 * @returns true なら重複（以降の処理をスキップすべき）
 */
export async function isDuplicateEventSubMessage(messageId: string): Promise<boolean> {
  if (!messageId) return false // ヘッダー欠落時は重複判定しない（署名検証で弾かれる）
  const binding = await getDedupKvBinding()
  if (!binding) return false // Workers 外 or KV 未設定: フェイルオープン
  try {
    const existing = await binding.get(`eventsub:dedup:${messageId}`)
    return existing !== null
  } catch {
    return false
  }
}

/**
 * message-id を KV へ記録する（処理完了後に呼び出すこと）。
 * 書き込み失敗時はフェイルオープン（次回も未知扱いになり、DB 層の UNIQUE 制約が
 * 二重付与の最終防御となる）。
 *
 * @param messageId twitch-eventsub-message-id ヘッダー値
 */
export async function markEventSubMessageSeen(messageId: string): Promise<void> {
  if (!messageId) return
  const binding = await getDedupKvBinding()
  if (!binding) return
  try {
    await binding.put(`eventsub:dedup:${messageId}`, '1', { expirationTtl: DEDUP_TTL_SECONDS })
  } catch {
    // 記録失敗は致命的ではない（二重付与は DB 層が防ぐ）
  }
}
