/**
 * users / streamers テーブルの単純クエリ用データアクセスヘルパー (#711)
 *
 * tos/accept API ルート・eventsub/subscribe API ルート（POST、#690 の重複統合）・
 * 複数の Server Component（/tos, /dashboard/account, /dashboard/history）から
 * 呼ばれる、cards に依存しない単純な単一行読み取りを集約する。#708 以降は
 * PlanetScale/Drizzle の単一経路で実行し、呼び出し元ごとに異なる既存の
 * エラー契約だけをこの境界で明示的に維持する。
 *
 * 設計方針（過剰な抽象化の回避。CLAUDE.md 規約 YAGNI）:
 * 3つのヘルパーはいずれも「異なる呼び出し元での既存のクセ」を個別に再現する
 * 必要があるため、無理に1つの汎用関数へ共通化していない。各関数のコメントに
 * 対応する呼び出し元と再現しているクセを明記する。
 */
import { eq } from 'drizzle-orm'

import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import { logger } from '@/lib/logger.server'
import { streamers as streamersTable, users as usersTable } from '@/lib/db/schema'

/**
 * getTosAcceptanceRow の戻り値。
 *
 * `{ row, error }` 契約にしている理由:
 * 同じクエリでも呼び出し元ごとに「エラー時の挙動」が異なるのが既存の正である。
 * - route.ts の GET: `if (error)` を検査して 500 応答 + logger.error
 * - tos/page.tsx: `const { data } = ...` で error を無視 → data=null →
 *   `userData?.tos_accepted_at !== null` が `undefined !== null` → true と評価され
 *   「クエリエラー時も hasAccepted=true」になる（クセ。修正は別Issue）
 * ヘルパーが throw する契約にすると、page 側の従来のエラー時挙動が
 * 「無視して true」から「catch して false」へ変わってしまうため、throw せず
 * error を値として返し、検査するか無視するかを
 * 呼び出し元の既存コードに委ねる。
 */
export interface TosAcceptanceRowResult {
  /**
   * - 行が存在しない（またはクエリエラー時）      → null
   * - 行は存在するが tos_accepted_at が未設定     → { tos_accepted_at: null }
   * - 行が存在し同意済み                          → { tos_accepted_at: '<ISO文字列>' }
   * 「行なし(null)」と「行はあるが値が null」の区別は、呼び出し元の
   * `row?.tos_accepted_at !== null` 判定（行なし → true になる既存のクセ）の
   * 再現に必須のため、この形を崩さないこと。
   */
  row: { tos_accepted_at: string | null } | null
  /** クエリエラー。呼び出し元が message をログに使う（route.ts の GET 参照） */
  error: { message: string } | null
}

/**
 * users.tos_accepted_at を1行取得する。
 * 呼び出し元: src/app/api/tos/accept/route.ts (GET), src/app/tos/page.tsx
 * エラー時は throw せず error を値で返す契約（理由は TosAcceptanceRowResult 参照）。
 */
export async function getTosAcceptanceRow(twitchUserId: string): Promise<TosAcceptanceRowResult> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ tos_accepted_at: usersTable.tos_accepted_at })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1) // twitch_user_id は UNIQUE（migration 00001）のため maybeSingle と同じ外部挙動
      },
      'getTosAcceptanceRow',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true }
    )
    return { row: rows[0] ?? null, error: null }
  } catch (error) {
    // pg 直結（postgres.js/Drizzle）はクエリエラーを throw するため、ここで
    // 捕捉して postgrest の { data: null, error } と同じ外形へ写像する。
    // ログを出す理由（チームレビュー SRE 指摘）: error を無視する呼び出し元
    // （tos/page.tsx）経由の pg 障害は、ここでログしないと withDbRetry の
    // console warn（errors テーブル→GitHub Issue 自動起票の対象外）しか痕跡が
    // 残らず、同ファイルの他2ヘルパー（logger.error 済み）と観測性が非対称に
    // なる。トレードオフ: error を検査する呼び出し元（route.ts GET）経由では
    // route 側の既存ログと合わせて同一障害が errors テーブルに2行記録されるが、
    // 二重起票のノイズより page 経路の可視性を優先する（クロスレビューで
    // セキュリティ・QA 両視点の異議なしを確認済み）。この catch は
    // 旧全体ドライバーフラグ=pg-read/pg 時のみ実行されるため、フラグ未設定時のログは不変。
    logger.error('Failed to fetch tos_accepted_at (pg), mapping to { row: null, error }', {
      twitchUserId,
      error,
    })
    return {
      row: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * users.twitch_has_sub を1行取得する。
 * 呼び出し元: src/app/dashboard/account/page.tsx の getTwitchSubInfo
 *
 * 既存の supabase-js 実装は `.maybeSingle()` の `{ data, error }` を分割代入する際に
 * error を無視し、常に data（クエリエラー時は通常 null）を返す設計になっている
 * （呼び出し元の try/catch は「例外が飛んだ場合」だけを保護しており、業務エラーは
 * 素通りする）。pg 直結（postgres.js/Drizzle）はクエリエラーを必ず throw するため、
 * 同じ「エラーを握りつぶして null を返す」挙動にするには本関数内で明示的に catch
 * する必要がある。呼び出し元の catch に丸投げすると外部挙動は変わらないが、
 * 呼び出し元の実装に依存せずこのヘルパー単体でも安全側（null 返却）に倒れる方が
 * 堅牢なため、ここで吸収する。
 */
export async function getTwitchSubRow(
  twitchUserId: string
): Promise<{ twitch_has_sub: boolean | null } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ twitch_has_sub: usersTable.twitch_has_sub })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1) // twitch_user_id は UNIQUE（migration 00001）のため maybeSingle と同じ外部挙動
      },
      'getTwitchSubRow',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true }
    )
    return rows[0] ?? null
  } catch (error) {
    // 既存 supabase-js 実装が業務エラーを無視して null を返すのと同じ外部挙動
    // （アカウント設定ページのレンダリングをブロックしない安全側の判断）。
    // ログレベルは warn ではなく error にする（厳格レビュー指摘）: パイロット群
    // （announcements.ts:209 の getUnreadAnnouncements、dashboard-data.ts:126 の
    // getStreamerData 等）は pg 例外を安全側の値へ写像する際に一貫して
    // logger.error を使っており、logger.error だけが errors テーブル経由の
    // GitHub Issue 自動起票（src/lib/logger.ts:34-38 の logErrorFromLogger）まで
    // 届く。warn のままだと同種の DB 障害でも本関数だけ起票対象から漏れ、
    // 観測性がパイロット群と非対称になるため error に統一する。
    logger.error('Failed to fetch twitch_has_sub (pg), returning null', { twitchUserId, error })
    return null
  }
}

/**
 * streamers.id を twitch_user_id から1行取得する。
 * 呼び出し元: src/app/dashboard/history/page.tsx、
 * src/app/api/twitch/eventsub/subscribe/route.ts の POST（#690 で個別実装していた
 * getStreamerIdPg と完全に同一クエリだったため、厳格レビュー指摘によりこのヘルパー
 * 1箇所に統合。route.ts 側は本関数を呼ぶだけで postgrest/pg 分岐を持たない）。
 *
 * 既存実装は `{ data: streamer }` のみを分割代入し error を見ない（かつページ全体も
 * try/catch で囲っていない）。したがって postgrest 経路のエラー時挙動は
 * 「data=null → 呼び出し元が『streamer なし』として return null（ページ非表示、
 * クラッシュしない）」である。pg 直結（postgres.js/Drizzle）はクエリエラーを throw
 * するため、そのまま伝播させると保護のない Server Component がクラッシュして
 * postgrest 経路（静かに null 表示）と外部挙動が食い違う。両ドライバで外部挙動を
 * 一致させるため、pg の例外はここで catch して null（= 行なしと同じ扱い）に写像する。
 *
 * 注意（DB障害マスクの既存バグを直す場合）: 上記の「DB障害時も『streamer なし』に
 * マスクする」挙動は history/page.tsx 由来の既存の潜在バグであり、eventsub/subscribe
 * ルートが本関数に統合された今は両呼び出し元とも本関数経由で同じマスクを受ける
 * （eventsub/subscribe 側は結果的に 404 STREAMER_NOT_FOUND、history 側はページ
 * 非表示になる）。postgrest / pg 両経路の実装がこの関数1箇所（下の pg 分岐の catch
 * と、下半分の postgrest 分岐の error 無視）に閉じているため、将来この挙動自体を
 * 修正する場合もこのヘルパー内の該当2箇所を直すだけでよく、呼び出し元
 * （route.ts / page.tsx）を個別に直す必要はない。
 */
export async function getStreamerIdByTwitchUserId(
  twitchUserId: string
): Promise<{ id: string } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1) // twitch_user_id は UNIQUE（migration 00001）のため maybeSingle と同じ外部挙動
      },
      'getStreamerIdByTwitchUserId',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true }
    )
    return rows[0] ?? null
  } catch (error) {
    // postgrest 経路が error を無視して null 表示になるのと同じ外部挙動に写像
    // （上記コメント参照）。原因調査用にログを残す（pg 経路のみの内部ログ。
    // 既存 postgrest 経路のログは増やさない）。
    // ログレベルは warn ではなく error にする（厳格レビュー指摘。理由は
    // getTwitchSubRow の catch 節コメント参照: パイロット群との観測性の非対称を
    // 避けるため、pg 例外→安全側マッピング時は logger.error に統一する）。
    logger.error('Failed to fetch streamer id (pg), returning null', { twitchUserId, error })
    return null
  }
}
