/**
 * Support inquiry data access layer
 * 問い合わせデータのサーバー側取得ロジック
 *
 * Server Componentから直接呼び出して問い合わせデータを取得する。
 * getSupabaseAdmin() を使用し、service_role でアクセスする（既存パターン踏襲）。
 */

import { and, asc, desc, eq } from 'drizzle-orm'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
// #663 (#570 パイロット踏襲): pg 直結（postgres.js + Drizzle）の読み取り経路。
// isPgReadEnabled() が true のときのみ使われ、フラグ未設定時（既定 'postgrest'）は
// 既存の supabase-js 実装が 1 文字も変わらず従来どおり実行される。
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import {
  supportInquiries as supportInquiriesTable,
  supportInquiryMessages as supportInquiryMessagesTable,
} from '@/lib/db/schema'
import { logger } from './logger'

export type InquiryCategory = 'bug' | 'feature' | 'other'
export type InquiryStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

export interface SupportInquiry {
  id: string
  twitch_user_id: string
  twitch_display_name: string
  category: InquiryCategory
  subject: string
  body: string
  status: InquiryStatus
  created_at: string
  updated_at: string
}

export interface SupportInquiryMessage {
  id: string
  inquiry_id: string
  sender_type: 'user' | 'admin'
  sender_id: string
  body: string
  created_at: string
}

/**
 * pg 直結経路のタイムスタンプ文字列をブラウザ安全な ISO 8601 に正規化する (#663)。
 *
 * 背景（日付の既知の表現差）: pg 直結（drizzle-orm/postgres-js）は timestamptz を
 * PG テキスト形式（'2026-03-10 12:00:00.123456+00'、スペース区切り）の文字列で返すが、
 * PostgREST は ISO 8601（'2026-03-10T12:00:00.123456+00:00'）を返す
 * （src/lib/db/client.ts の createHandle コメント参照）。
 *
 * PG テキスト形式の Date パースは V8（サーバー側 workerd / Node）では実地検証済みだが
 * （src/app/api/overlay/[streamerId]/events/route.ts の判断コメント参照）、ECMA-262 が
 * パースを保証するのは ISO 8601 のみで、それ以外は実装依存。問い合わせ機能の日付は
 * ブラウザ側（任意のエンジン: Safari/JavaScriptCore 等を含む）のクライアント
 * コンポーネント（InquiryThread.tsx）や API レスポンス消費者で new Date() される
 * ため、サーバー側（V8 保証あり）で ISO 8601 へ正規化してから返す。
 * PostgREST 経路も ISO 8601 を返すため、正規化後は「ISO 8601 文字列」という
 * 外部契約が両経路で一致する（既知の残差: マイクロ秒→ミリ秒への丸めと
 * '+00:00'→'Z' の表記。時刻値は同一で、消費側はすべて Date 経由のため影響なし）。
 *
 * Date.parse できない想定外の形式は元の文字列をそのまま返す（値を握り潰して
 * null にするより情報を保つ安全側。overlay events route の normalizeDateParam と
 * 同じ「パース成功時のみ toISOString」方針）。
 */
export function normalizePgTimestamp(value: string | null): string | null {
  if (value === null) {
    return null
  }
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toISOString()
}

/**
 * getUserInquiries の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - twitch_user_id 一致を created_at 降順で取得（同一のクエリ意味論）。
 * - エラー時は空配列を返す（既存実装の error 分岐 / catch と同じ外部挙動。
 *   [db:pg] タグ付きの失敗詳細は withDbRetry が warn ログに残す）。
 * - 読み取り専用クエリのため冪等（idempotent: true）としてリトライを opt-in。
 *
 * 日付は正規化せず生文字列のまま返す（dashboard-data.ts の方針）: 本関数の消費側は
 * src/app/dashboard/inquiries/page.tsx（Server Component）のみで、created_at を
 * サーバー側 V8 の new Date().toLocaleDateString() でしか扱わない（クライアント
 * コンポーネントへ日付文字列は渡らない。DeleteInquiryButton へは id のみ）。
 * V8 は PG テキスト形式をパースできることを実地検証済み（overlay events route の
 * 判断コメント参照）。日付文字列をブラウザへ渡す消費側を今後追加する場合は
 * normalizePgTimestamp を通すこと。
 */
async function getUserInquiriesPg(twitchUserId: string): Promise<SupportInquiry[]> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({
            id: supportInquiriesTable.id,
            twitch_user_id: supportInquiriesTable.twitch_user_id,
            twitch_display_name: supportInquiriesTable.twitch_display_name,
            category: supportInquiriesTable.category,
            subject: supportInquiriesTable.subject,
            body: supportInquiriesTable.body,
            status: supportInquiriesTable.status,
            created_at: supportInquiriesTable.created_at,
            updated_at: supportInquiriesTable.updated_at,
          })
          .from(supportInquiriesTable)
          .where(eq(supportInquiriesTable.twitch_user_id, twitchUserId))
          .orderBy(desc(supportInquiriesTable.created_at))
      },
      'getUserInquiries',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )

    // category/status は DB の CHECK 制約（migration 00019）で列挙値が保証されており、
    // created_at/updated_at は DDL が DEFAULT NOW()（NOT NULL なし）のため Drizzle 型は
    // string | null だが実運用で NULL にはならない。PostgREST 経路も型検証なしで同じ
    // 生値を SupportInquiry として返しているため、値の変換をしない型キャストで
    // 既存の戻り値型に合わせる（announcements.ts の getUnreadAnnouncementsPg と同じ判断）。
    return rows as SupportInquiry[]
  } catch (error) {
    // 既存実装と同じく「取得失敗時は空一覧」の安全側の挙動（error 分岐 / catch とも []）
    logger.error('Error in getUserInquiries (pg)', { error })
    return []
  }
}

/**
 * ユーザーの問い合わせ一覧を取得
 *
 * @param twitchUserId - TwitchユーザーID
 * @returns 問い合わせ一覧（作成日時の降順）
 */
export async function getUserInquiries(twitchUserId: string): Promise<SupportInquiry[]> {
  // #663: 読み取り専用の関数のため isPgReadEnabled() で分岐（pg-read / pg の両モードで
  // pg 直結）。フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存 supabase-js
  // 実装が従来と完全に同一に実行される（挙動不変が Phase 1 の最重要安全要件）。
  if (isPgReadEnabled()) {
    return getUserInquiriesPg(twitchUserId)
  }

  try {
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('support_inquiries')
      .select('id, twitch_user_id, twitch_display_name, category, subject, body, status, created_at, updated_at')
      .eq('twitch_user_id', twitchUserId)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('Failed to fetch user inquiries', { error: error.message })
      return []
    }

    return (data || []) as SupportInquiry[]
  } catch (error) {
    logger.error('Error in getUserInquiries', { error })
    return []
  }
}

/**
 * getInquiryWithMessages の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - 問い合わせ本体の .single() は id が PRIMARY KEY（migration 00019）で最大 1 行の
 *   ため、.limit(1) + rows[0] ?? null が同じ外部挙動（0 行 = null → 呼び出し元で
 *   notFound() 相当）。取得エラーも既存実装が inquiryError を握り潰して null を
 *   返すのに合わせ、catch して null（失敗詳細は withDbRetry の [db:pg] warn に残る）。
 *   なお呼び出し元（詳細ページ）は inquiryId を UUID 検証せずに渡すため、不正形式は
 *   pg 直結では 22P02 の throw になるが、この catch → null により PostgREST 経路
 *   （PostgREST がエラーを返し null）と同じ外部挙動になる。
 * - メッセージ取得の失敗は「ログを出して messages: [] で継続」（既存実装と同じ）。
 * - 読み取り専用クエリのため両クエリとも冪等（idempotent: true）でリトライ opt-in。
 *
 * 日付は normalizePgTimestamp で ISO 8601 へ正規化して返す（関数冒頭コメント参照）:
 * 本関数の inquiry.created_at と messages[].created_at は詳細ページ（Server
 * Component）からクライアントコンポーネント InquiryThread.tsx の props に渡り、
 * ブラウザ側（任意のエンジン）で new Date() されるため、PG テキスト形式のままでは
 * パースが実装依存になる。PostgREST 経路はもともと ISO 8601 を返すため、正規化に
 * より両経路とも「ブラウザで安全にパースできる ISO 8601」で一致する。
 */
async function getInquiryWithMessagesPg(
  inquiryId: string,
  twitchUserId: string
): Promise<{ inquiry: SupportInquiry; messages: SupportInquiryMessage[] } | null> {
  // 問い合わせ本体を取得（ユーザーIDで所有権チェック）
  let inquiryRow:
    | {
        id: string
        twitch_user_id: string
        twitch_display_name: string
        category: string
        subject: string
        body: string
        status: string
        created_at: string | null
        updated_at: string | null
      }
    | null
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({
            id: supportInquiriesTable.id,
            twitch_user_id: supportInquiriesTable.twitch_user_id,
            twitch_display_name: supportInquiriesTable.twitch_display_name,
            category: supportInquiriesTable.category,
            subject: supportInquiriesTable.subject,
            body: supportInquiriesTable.body,
            status: supportInquiriesTable.status,
            created_at: supportInquiriesTable.created_at,
            updated_at: supportInquiriesTable.updated_at,
          })
          .from(supportInquiriesTable)
          .where(
            and(
              eq(supportInquiriesTable.id, inquiryId),
              eq(supportInquiriesTable.twitch_user_id, twitchUserId)
            )
          )
          // id は PRIMARY KEY のため最大 1 行（.single() と同じ外部挙動の根拠）
          .limit(1)
      },
      'getInquiryWithMessages(inquiry)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    inquiryRow = rows[0] ?? null
  } catch {
    // 既存実装は inquiryError をログなしで握り潰して null（呼び出し元が 404 相当に
    // 落とす）。同じ外部挙動。[db:pg] タグ付きの失敗詳細は withDbRetry が warn に残す。
    return null
  }

  if (!inquiryRow) {
    return null
  }

  // 値の変換をしない型キャストの根拠は getUserInquiriesPg のコメント参照
  // （CHECK 制約による列挙値保証・タイムスタンプの実質非 NULL）。
  const inquiry: SupportInquiry = {
    ...inquiryRow,
    category: inquiryRow.category as InquiryCategory,
    status: inquiryRow.status as InquiryStatus,
    created_at: normalizePgTimestamp(inquiryRow.created_at) as string,
    updated_at: normalizePgTimestamp(inquiryRow.updated_at) as string,
  }

  // メッセージを時系列順で取得
  try {
    const messageRows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({
            id: supportInquiryMessagesTable.id,
            inquiry_id: supportInquiryMessagesTable.inquiry_id,
            sender_type: supportInquiryMessagesTable.sender_type,
            sender_id: supportInquiryMessagesTable.sender_id,
            body: supportInquiryMessagesTable.body,
            created_at: supportInquiryMessagesTable.created_at,
          })
          .from(supportInquiryMessagesTable)
          .where(eq(supportInquiryMessagesTable.inquiry_id, inquiryId))
          .orderBy(asc(supportInquiryMessagesTable.created_at))
      },
      'getInquiryWithMessages(messages)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )

    return {
      inquiry,
      messages: messageRows.map((row) => ({
        ...row,
        sender_type: row.sender_type as SupportInquiryMessage['sender_type'],
        created_at: normalizePgTimestamp(row.created_at) as string,
      })),
    }
  } catch (error) {
    // 既存実装と同じく「メッセージ取得失敗はログを出して空配列で継続」
    logger.error('Failed to fetch inquiry messages', { error })
    return { inquiry, messages: [] }
  }
}

/**
 * 問い合わせ詳細とメッセージを取得（所有権チェック付き）
 *
 * @param inquiryId - 問い合わせID
 * @param twitchUserId - TwitchユーザーID（所有権チェック用）
 * @returns 問い合わせ詳細とメッセージ、見つからない場合はnull
 */
export async function getInquiryWithMessages(
  inquiryId: string,
  twitchUserId: string
): Promise<{ inquiry: SupportInquiry; messages: SupportInquiryMessage[] } | null> {
  // #663: 読み取り専用の関数のため isPgReadEnabled() で分岐。フラグ未設定時
  // （既定 'postgrest'）は素通りし、以下の既存実装が従来どおり実行される。
  if (isPgReadEnabled()) {
    return getInquiryWithMessagesPg(inquiryId, twitchUserId)
  }

  try {
    const supabase = getSupabaseAdmin()

    // 問い合わせ本体を取得（ユーザーIDで所有権チェック）
    const { data: inquiry, error: inquiryError } = await supabase
      .from('support_inquiries')
      .select('id, twitch_user_id, twitch_display_name, category, subject, body, status, created_at, updated_at')
      .eq('id', inquiryId)
      .eq('twitch_user_id', twitchUserId)
      .single()

    if (inquiryError || !inquiry) {
      return null
    }

    // メッセージを時系列順で取得
    const { data: messages, error: messagesError } = await supabase
      .from('support_inquiry_messages')
      .select('id, inquiry_id, sender_type, sender_id, body, created_at')
      .eq('inquiry_id', inquiryId)
      .order('created_at', { ascending: true })

    if (messagesError) {
      logger.error('Failed to fetch inquiry messages', { error: messagesError.message })
      return { inquiry: inquiry as SupportInquiry, messages: [] }
    }

    return {
      inquiry: inquiry as SupportInquiry,
      messages: (messages || []) as SupportInquiryMessage[],
    }
  } catch (error) {
    logger.error('Error in getInquiryWithMessages', { error })
    return null
  }
}
