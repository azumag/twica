/**
 * Twitch サブスクライバー判定モジュール
 *
 * Twitch API の Check User Subscription エンドポイントで
 * 指定チャネルのサブスク状態を判定する。
 * getUserPlan() はキャッシュ済み DB 結果のみ参照し、API は直接呼ばない。
 *
 * キャッシュ戦略:
 * - 正常時: CACHE_DURATION_MS（1時間）で再検証
 * - APIエラー時: ERROR_CACHE_DURATION_MS（5分）で再検証（リトライストーム防止）
 * - 401/403: スコープ除去は行わず null を返す（一時障害での誤降格を防止）
 *   スコープ除去はユーザーの手動確認 API (check-subscription) でのみ行う
 */

import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getEnvVar } from '@/lib/env-validation'
import { getTwitchAccessToken } from '@/lib/twitch/token-manager'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { logger } from '@/lib/logger'
// -----------------------------------------------------------------------------
// #572 (#570 パイロット踏襲): pg 直結経路。
// hasTwitchSub はキャッシュ読み取りとキャッシュ更新（users への UPDATE 2 箇所）が
// 混在する関数のため、関数全体を isPgWriteEnabled() で分岐する（token-manager.ts
// 冒頭のフラグ使い分け方針と同じ。読み書きで別経路が混ざると障害切り分けが困難に
// なるため、pg-read モードでは本関数は従来の PostgREST 経路のまま動く）。
// 既存 supabase-js 実装は 1 文字も変えず、フラグ未設定時は完全に従来どおり動く。
// -----------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { users as usersTable } from '@/lib/db/schema'

// キャッシュ有効期間: 正常時1時間
const CACHE_DURATION_MS = 60 * 60 * 1000
// APIエラー時のキャッシュ有効期間: 5分（リトライストーム防止）
const ERROR_CACHE_DURATION_MS = 5 * 60 * 1000

/**
 * Twitch サブスク確認機能が有効か判定（環境変数チェック）
 */
export function isTwitchSubCheckEnabled(): boolean {
  return !!getEnvVar('TWITCH_BROADCASTER_ID')
}

/**
 * ユーザーが対象チャネルをサブスクライブしているか判定
 *
 * 1. twitch_sub_verified_at が1時間以内 → twitch_has_sub のキャッシュ結果を返す
 * 2. キャッシュ期限切れ → Twitch API で確認し、結果を DB に保存
 * 3. user:read:subscriptions スコープ未付与 → 即座に false
 */
/**
 * hasTwitchSub の pg 直結実装 (#572)
 *
 * PostgREST 実装との対応:
 * - users の読み取り: .maybeSingle() は twitch_user_id の UNIQUE 制約（migration
 *   00001）により最大 1 行のため、LIMIT 1 + rows[0] ?? null が同じ外部挙動。
 *   取得失敗（error）は既存実装と同じく false に落とす。
 * - キャッシュ更新（UPDATE 2 箇所）: 既存の .update().eq().select().maybeSingle()
 *   （マッチ 0 行検出のための returning パターン）は Drizzle の .returning() で
 *   形状を合わせる。更新失敗はログのみでリクエスト継続（既存と同じ）。
 * - twitch_sub_verified_at の値は queryFn の外で 1 度だけ計算し、リトライしても
 *   同じ値を書く UPDATE（= 冪等）になるようにする。
 * - twitch_scopes は text[] 列のため Drizzle スキーマ経由で読む
 *   （src/lib/db/client.ts の fetch_types: false の注意書き参照）。
 * - twitch_sub_verified_at は pg 直結だと src/lib/db/client.ts の
 *   installIsoTimestampParsers() により ISO 8601 に正規化された文字列で返る
 *   （#688。正規化前は PG テキスト形式だった）。消費は new Date() 経由の
 *   キャッシュ期限判定のみ（戻り値には含めない）ため、正規化前後どちらの形式でも
 *   影響はない（token-manager.ts 冒頭コメントと同じ既知事項）。
 */
async function hasTwitchSubPg(twitchUserId: string): Promise<boolean> {
  try {
    let user:
      | {
          twitch_sub_verified_at: string | null
          twitch_has_sub: boolean | null
          twitch_scopes: string[] | null
        }
      | null
    try {
      const rows = await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { db } = await getDb()
          return db
            .select({
              twitch_sub_verified_at: usersTable.twitch_sub_verified_at,
              twitch_has_sub: usersTable.twitch_has_sub,
              twitch_scopes: usersTable.twitch_scopes,
            })
            .from(usersTable)
            .where(eq(usersTable.twitch_user_id, twitchUserId))
            .limit(1)
        },
        'hasTwitchSub(user)',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      )
      user = rows[0] ?? null
    } catch {
      // 既存実装は取得エラー時 false（分割代入の error → return false）。同じ外部挙動。
      return false
    }

    if (!user) {
      return false
    }

    // user:read:subscriptions スコープがなければ判定不可
    if (!user.twitch_scopes?.includes(ADDITIONAL_SCOPES.USER_READ_SUBSCRIPTIONS)) {
      return false
    }

    // キャッシュ判定: 1時間以内なら前回の結果を返す
    if (user.twitch_sub_verified_at) {
      const verifiedAt = new Date(user.twitch_sub_verified_at).getTime()
      if (Date.now() - verifiedAt < CACHE_DURATION_MS) {
        return user.twitch_has_sub === true
      }
    }

    // キャッシュ期限切れ → Twitch API で確認
    const { hasSub } = await checkTwitchSubViaApi(twitchUserId)

    if (hasSub !== null) {
      // 正常結果: DB に保存（通常キャッシュ TTL で再検証）
      // キャッシュ更新失敗はリクエスト継続に影響しない（次回アクセス時に再試行される）
      const verifiedAtIso = new Date().toISOString()
      try {
        const updatedRows = await withDbRetry(
          async () => {
            const { db } = await getDb()
            return db
              .update(usersTable)
              .set({
                twitch_sub_verified_at: verifiedAtIso,
                twitch_has_sub: hasSub,
              })
              .where(eq(usersTable.twitch_user_id, twitchUserId))
              .returning({ twitch_user_id: usersTable.twitch_user_id })
          },
          'hasTwitchSub(update cache)',
          // 事前計算した同じ値を書く UPDATE のためリトライしても冪等
          { idempotent: true },
        )
        // ユーザー削除等で 0 行更新となっても、次回 hasTwitchSub() でユーザー未取得 → false で解消
        if (!updatedRows[0]) {
          logger.error('[TwitchSub] Failed to update sub cache:', { twitchUserId, error: null, updatedUser: null })
        }
      } catch (updateError) {
        logger.error('[TwitchSub] Failed to update sub cache:', { twitchUserId, error: updateError, updatedUser: null })
      }

      return hasSub
    }

    // API エラー時: タイムスタンプのみ更新して短縮 TTL でリトライを抑制
    // twitch_has_sub は前回値を保持（ユーザーに不利にしない）
    // 計算: now - (1h - 5min) = 55分前 → キャッシュ判定で「55分 < 60分 = 有効」→ 5分後に期限切れ
    const errorCacheTimestamp = new Date(Date.now() - (CACHE_DURATION_MS - ERROR_CACHE_DURATION_MS))
    try {
      const updatedTsRows = await withDbRetry(
        async () => {
          const { db } = await getDb()
          return db
            .update(usersTable)
            .set({
              twitch_sub_verified_at: errorCacheTimestamp.toISOString(),
            })
            .where(eq(usersTable.twitch_user_id, twitchUserId))
            .returning({ twitch_user_id: usersTable.twitch_user_id })
        },
        'hasTwitchSub(update error cache)',
        // 事前計算した同じタイムスタンプを書く UPDATE のためリトライしても冪等
        { idempotent: true },
      )
      if (!updatedTsRows[0]) {
        logger.error('[TwitchSub] Failed to update error cache timestamp:', { twitchUserId, error: null, updatedTs: null })
      }
    } catch (tsError) {
      logger.error('[TwitchSub] Failed to update error cache timestamp:', { twitchUserId, error: tsError, updatedTs: null })
    }

    return user.twitch_has_sub === true
  } catch (error) {
    logger.error('[TwitchSub] Error checking subscription:', { twitchUserId, error })
    return false
  }
}

export async function hasTwitchSub(twitchUserId: string): Promise<boolean> {
  if (!isTwitchSubCheckEnabled()) {
    return false
  }

  // #572: キャッシュ更新（書き込み）を含む読み書き混在関数のため isPgWriteEnabled()
  // で関数全体を分岐。フラグ未設定時（既定 'postgrest'）は素通りし従来どおり動く。
  if (isPgWriteEnabled()) {
    return hasTwitchSubPg(twitchUserId)
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('twitch_sub_verified_at, twitch_has_sub, twitch_scopes')
      .eq('twitch_user_id', twitchUserId)
      .maybeSingle()

    if (error || !user) {
      return false
    }

    // user:read:subscriptions スコープがなければ判定不可
    if (!user.twitch_scopes?.includes(ADDITIONAL_SCOPES.USER_READ_SUBSCRIPTIONS)) {
      return false
    }

    // キャッシュ判定: 1時間以内なら前回の結果を返す
    if (user.twitch_sub_verified_at) {
      const verifiedAt = new Date(user.twitch_sub_verified_at).getTime()
      if (Date.now() - verifiedAt < CACHE_DURATION_MS) {
        return user.twitch_has_sub === true
      }
    }

    // キャッシュ期限切れ → Twitch API で確認
    const { hasSub } = await checkTwitchSubViaApi(twitchUserId)

    if (hasSub !== null) {
      // 正常結果: DB に保存（通常キャッシュ TTL で再検証）
      const { data: updatedUser, error: updateError } = await supabaseAdmin
        .from('users')
        .update({
          twitch_sub_verified_at: new Date().toISOString(),
          twitch_has_sub: hasSub,
        })
        .eq('twitch_user_id', twitchUserId)
        .select('twitch_user_id')
        .maybeSingle()

      // キャッシュ更新失敗はリクエスト継続に影響しない（次回アクセス時に再試行される）
      // ユーザー削除等で0行更新となっても、次回 hasTwitchSub() でユーザー未取得 → false で解消
      if (updateError || !updatedUser) {
        logger.error('[TwitchSub] Failed to update sub cache:', { twitchUserId, error: updateError, updatedUser })
      }

      return hasSub
    }

    // API エラー時: タイムスタンプのみ更新して短縮 TTL でリトライを抑制
    // twitch_has_sub は前回値を保持（ユーザーに不利にしない）
    // 計算: now - (1h - 5min) = 55分前 → キャッシュ判定で「55分 < 60分 = 有効」→ 5分後に期限切れ
    const errorCacheTimestamp = new Date(Date.now() - (CACHE_DURATION_MS - ERROR_CACHE_DURATION_MS))
    const { data: updatedTs, error: tsError } = await supabaseAdmin
      .from('users')
      .update({
        twitch_sub_verified_at: errorCacheTimestamp.toISOString(),
      })
      .eq('twitch_user_id', twitchUserId)
      .select('twitch_user_id')
      .maybeSingle()

    if (tsError || !updatedTs) {
      logger.error('[TwitchSub] Failed to update error cache timestamp:', { twitchUserId, error: tsError, updatedTs })
    }

    return user.twitch_has_sub === true
  } catch (error) {
    logger.error('[TwitchSub] Error checking subscription:', { twitchUserId, error })
    return false
  }
}

export type SubCheckResult = {
  hasSub: boolean | null
  /** 401/403 による認証エラーか（スコープ除去判断に使用） */
  authError: boolean
}

/**
 * Twitch API でサブスク状態を確認
 * @returns hasSub: true=サブスク中, false=非サブスク, null=APIエラー
 *          authError: 401/403 が原因のエラーか
 */
export async function checkTwitchSubViaApi(twitchUserId: string): Promise<SubCheckResult> {
  const broadcasterId = getEnvVar('TWITCH_BROADCASTER_ID')
  if (!broadcasterId) {
    return { hasSub: null, authError: false }
  }

  try {
    const accessToken = await getTwitchAccessToken(twitchUserId)
    if (!accessToken) {
      logger.warn('[TwitchSub] No access token available', { twitchUserId })
      return { hasSub: null, authError: false }
    }

    const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
    const url = `https://api.twitch.tv/helix/subscriptions/user?broadcaster_id=${broadcasterId}&user_id=${twitchUserId}`

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': clientId,
      },
    })

    if (response.ok) {
      return { hasSub: true, authError: false }
    }

    if (response.status === 404) {
      // 404: 非サブスク（正常系 — 明示的に false を返してプラン降格を実行）
      return { hasSub: false, authError: false }
    }

    if (response.status === 401 || response.status === 403) {
      // 401/403: トークンまたはスコープの問題
      // ※ バックグラウンド処理（hasTwitchSub）からはスコープ除去しない。
      //   一時的な Twitch 障害で誤ってスコープを剥奪するとプラン降格が発生するため。
      //   スコープ除去はユーザーの手動確認 API (check-subscription) でのみ行う。
      logger.warn('[TwitchSub] Auth error (scope removal deferred to manual check)', {
        twitchUserId,
        status: response.status,
      })
      return { hasSub: null, authError: true }
    }

    // その他のエラー（5xx, ネットワーク障害等）: 前回結果を保持
    logger.warn('[TwitchSub] Unexpected API response', {
      twitchUserId,
      status: response.status,
    })
    return { hasSub: null, authError: false }
  } catch (error) {
    logger.error('[TwitchSub] API call failed', { twitchUserId, error })
    return { hasSub: null, authError: false }
  }
}
