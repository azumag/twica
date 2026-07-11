import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { withRetry } from '@/lib/supabase/retry';
import { refreshTwitchToken, type TwitchTokens } from './auth';
import { logger } from '@/lib/logger';
// -----------------------------------------------------------------------------
// #572 (#570 パイロット踏襲): pg 直結経路。
// 各関数の先頭でフラグ分岐し、既存 supabase-js 実装は 1 文字も変えずに残す
// （フラグ未設定時は完全に従来どおり動く）。pg 実装は同ファイル内の xxxPg 関数に
// 置き、getDb() は withDbRetry の queryFn 内で呼ぶ規約（src/lib/db/retry.ts 参照）。
//
// フラグの使い分け（#572 の設計判断）:
// - 読み取りだけの関数 → isPgReadEnabled()（pg-read / pg で切替）
// - 書き込みを含む関数（読み取りが混在する場合も含む）→ isPgWriteEnabled()
//   （pg のときのみ切替。読み書きで別経路が混ざると障害切り分けが困難になるため、
//   混在関数は関数全体を書き込みフラグで分岐する）
//
// 日付の表現形式（#688 で更新。announcements.ts / dashboard-data.ts パイロットと同様）:
// pg 直結の timestamptz は src/lib/db/client.ts の installIsoTimestampParsers()
// により接続確立時に ISO 8601 へ正規化されるため、PostgREST 経路と表現形式が
// 一致する（正規化前は PG テキスト形式 '2026-03-10 12:00:00.123456+00' だった）。
// 本モジュールの日付消費はすべて new Date() 経由の期限判定のみで（日付文字列を
// 戻り値として返す関数は無い）、正規化前後どちらの形式でも V8 は同一時刻に解釈
// するため実害はなかったが、正規化後は文字列表現も PostgREST 経路と一致する。
// -----------------------------------------------------------------------------
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { isPgReadEnabled, isPgWriteEnabled } from '@/lib/db/flags';
import { withDbRetry } from '@/lib/db/retry';
import { isPgMissingColumnError, isPgMissingTableError } from '@/lib/db/errors';
import {
  streamers as streamersTable,
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  twitchBotAccounts as twitchBotAccountsTable,
  users as usersTable,
} from '@/lib/db/schema';

export class TwitchTokenError extends Error {
  constructor(
    message: string,
    public readonly code: 'NO_TOKEN' | 'REFRESH_FAILED' | 'DATABASE_ERROR' | 'USER_NOT_FOUND',
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'TwitchTokenError';
  }
}

/**
 * getTwitchAccessToken の pg 直結実装 (#572)
 *
 * PostgREST 実装との対応:
 * - users を twitch_user_id で 1 行取得。既存の .maybeSingle() は twitch_user_id の
 *   UNIQUE 制約（migration 00001）により最大 1 行なので、LIMIT 1 + rows[0] ?? null で
 *   同じ外部挙動になる（0 行はエラーではなく null）。
 * - 列未デプロイ時の 42703 → warn + null について: 既存 postgrest 経路の PGRST204
 *   分岐は SELECT では実際には作動しない（PGRST204 はリクエストボディの列が
 *   スキーマキャッシュに無い「書き込み時」のコード。SELECT の列欠落は PostgREST
 *   でも PostgreSQL の 42703 がエラー応答としてそのまま返り、既存実装は
 *   TwitchTokenError('DATABASE_ERROR') として throw する）。つまり pg 版の
 *   isPgMissingColumnError → warn + null は PGRST204 の忠実な再現ではなく、
 *   トークン列追加マイグレーション前のコードが先行デプロイされる窓（SELECT 系
 *   デプロイ窓）で、トークン取得を例外で落とすのではなく「トークン無し」として
 *   安全側に倒すための意図的な動作である。
 * - 取得後の期限判定は既存実装と同一ロジック。期限切れ時の refreshTwitchAccessToken は
 *   共有関数のまま呼び、その内部で isPgWriteEnabled() により独立して経路が選ばれる
 *   （pg-read では読み取りのみ pg、書き込みは PostgREST という運用モードそのもの）。
 */
async function getTwitchAccessTokenPg(twitchUserId: string): Promise<string | null> {
  let user:
    | {
        twitch_access_token: string | null;
        twitch_refresh_token: string | null;
        twitch_token_expires_at: string | null;
      }
    | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            twitch_access_token: usersTable.twitch_access_token,
            twitch_refresh_token: usersTable.twitch_refresh_token,
            twitch_token_expires_at: usersTable.twitch_token_expires_at,
          })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      'twitch token fetch',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    user = rows[0] ?? null;
  } catch (dbError) {
    if (isPgMissingColumnError(dbError)) {
      logger.warn('Twitch token columns not found in schema', { twitchUserId, error: dbError });
      return null;
    }
    logger.error('Database error fetching user tokens', { twitchUserId, error: dbError });
    throw new TwitchTokenError(
      'Failed to fetch user tokens from database',
      'DATABASE_ERROR',
      dbError instanceof Error ? dbError : undefined
    );
  }

  if (!user || !user.twitch_access_token || !user.twitch_refresh_token) {
    return null;
  }

  if (!user.twitch_token_expires_at) {
    return null;
  }

  const expiresAt = new Date(user.twitch_token_expires_at);
  if (isNaN(expiresAt.getTime())) {
    return null;
  }

  const now = new Date();
  if (expiresAt > now) {
    return user.twitch_access_token;
  }

  return await refreshTwitchAccessToken(twitchUserId, user.twitch_refresh_token);
}

export async function getTwitchAccessToken(twitchUserId: string): Promise<string | null> {
  // #572: この関数自体の DB アクセスは読み取りのみのため isPgReadEnabled() で分岐。
  // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
  if (isPgReadEnabled()) {
    return getTwitchAccessTokenPg(twitchUserId);
  }

  const supabaseAdmin = getSupabaseAdmin();

  const { data: user, error: dbError } = await withRetry(
    () => supabaseAdmin
      .from('users')
      .select('twitch_access_token, twitch_refresh_token, twitch_token_expires_at')
      .eq('twitch_user_id', twitchUserId)
      .maybeSingle(),
    'twitch token fetch',
  );

  if (dbError) {
    // PGRST204 means column not found - token columns may not exist in schema
    if (dbError.code === 'PGRST204') {
      logger.warn('Twitch token columns not found in schema', { twitchUserId, error: dbError });
      return null;
    }

    // Other database errors are unexpected and should be thrown
    // maybeSingle()を使用しているため、行が見つからない場合はerrorではなくdata=nullが返る
    logger.error('Database error fetching user tokens', { twitchUserId, error: dbError });
    throw new TwitchTokenError(
      'Failed to fetch user tokens from database',
      'DATABASE_ERROR',
      dbError
    );
  }

  if (!user || !user.twitch_access_token || !user.twitch_refresh_token) {
    return null;
  }

  if (!user.twitch_token_expires_at) {
    return null;
  }

  const expiresAt = new Date(user.twitch_token_expires_at);
  if (isNaN(expiresAt.getTime())) {
    return null;
  }

  const now = new Date();
  if (expiresAt > now) {
    return user.twitch_access_token;
  }

  return await refreshTwitchAccessToken(twitchUserId, user.twitch_refresh_token);
}

export interface BotChatAccount {
  accountId: string;
  senderId: string;
  username: string | null;
  displayName: string | null;
  accessToken: string;
  ownerType: 'streamer' | 'system';
}

interface BotAccountRow {
  id: string;
  owner_type: 'streamer' | 'system';
  twitch_user_id: string;
  twitch_username: string | null;
  twitch_display_name: string | null;
  twitch_access_token: string;
  twitch_refresh_token: string;
  twitch_token_expires_at: string;
}

function isMissingBotSchemaError(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST204' || error?.code === 'PGRST205' || error?.code === '42P01';
}

/**
 * isMissingBotSchemaError の pg 直結版 (#572)
 * PostgREST の PGRST204（列がスキーマキャッシュに無い）/ PGRST205（テーブルが
 * スキーマキャッシュに無い）は PostgREST 固有のコードで、pg 直結では PostgreSQL が
 * 直接 42703 (undefined_column) / 42P01 (undefined_table) を返すため両者で判定する。
 */
function isMissingBotSchemaErrorPg(error: unknown): boolean {
  return isPgMissingColumnError(error) || isPgMissingTableError(error);
}

/**
 * getBotAccountForChat の pg 直結実装 (#572)
 *
 * 読み取り（streamers / streamer_chat_sender_settings / twitch_bot_accounts）と
 * 書き込み（リフレッシュ後のトークン保存・エラーステータス保存）が混在する関数の
 * ため、呼び出し元は isPgWriteEnabled() で関数全体を分岐する（ファイル冒頭の
 * フラグ使い分け方針を参照）。
 *
 * PostgREST 実装との対応:
 * - 各 .maybeSingle() は一意条件（streamers.twitch_user_id UNIQUE /
 *   streamer_chat_sender_settings.streamer_id PK / twitch_bot_accounts.id PK）
 *   での取得のため LIMIT 1 + rows[0] ?? null で同じ外部挙動。official_bot の
 *   .order(created_at, ascending).limit(1) は orderBy(asc) + limit(1) が等価。
 * - isMissingBotSchemaError による「BOT スキーマ未デプロイ窓」フォールバックは
 *   isMissingBotSchemaErrorPg（42703/42P01）で再現。
 * - トークン値はログに出さない（既存のログ慣習どおり error オブジェクトのみ）。
 */
async function getBotAccountForChatPg(broadcasterTwitchUserId: string): Promise<BotChatAccount | null> {
  let streamer: { id: string } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, broadcasterTwitchUserId))
          .limit(1);
      },
      'getBotAccountForChat(streamers)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    streamer = rows[0] ?? null;
  } catch (dbError) {
    logger.error('Database error fetching BOT account', { broadcasterTwitchUserId, error: dbError });
    throw new TwitchTokenError(
      'Failed to fetch BOT account from database',
      'DATABASE_ERROR',
      dbError instanceof Error ? dbError : undefined
    );
  }

  if (!streamer) {
    return null;
  }
  // withDbRetry の queryFn（closure）から参照するため const に固定する
  const streamerId = streamer.id;

  let senderSettings: { sender_mode: string; custom_bot_account_id: string | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            sender_mode: streamerChatSenderSettingsTable.sender_mode,
            custom_bot_account_id: streamerChatSenderSettingsTable.custom_bot_account_id,
          })
          .from(streamerChatSenderSettingsTable)
          .where(eq(streamerChatSenderSettingsTable.streamer_id, streamerId))
          .limit(1);
      },
      'getBotAccountForChat(sender settings)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    senderSettings = rows[0] ?? null;
  } catch (settingsError) {
    if (isMissingBotSchemaErrorPg(settingsError)) {
      logger.warn('Chat sender settings table not found in schema', { broadcasterTwitchUserId });
      return null;
    }
    logger.error('Database error fetching chat sender settings', { broadcasterTwitchUserId, error: settingsError });
    throw new TwitchTokenError(
      'Failed to fetch chat sender settings from database',
      'DATABASE_ERROR',
      settingsError instanceof Error ? settingsError : undefined
    );
  }

  if (!senderSettings || senderSettings.sender_mode === 'streamer') {
    return null;
  }

  // PostgREST 経路の select 文字列と同一の 8 列（両モード共通）
  const botAccountColumns = {
    id: twitchBotAccountsTable.id,
    owner_type: twitchBotAccountsTable.owner_type,
    twitch_user_id: twitchBotAccountsTable.twitch_user_id,
    twitch_username: twitchBotAccountsTable.twitch_username,
    twitch_display_name: twitchBotAccountsTable.twitch_display_name,
    twitch_access_token: twitchBotAccountsTable.twitch_access_token,
    twitch_refresh_token: twitchBotAccountsTable.twitch_refresh_token,
    twitch_token_expires_at: twitchBotAccountsTable.twitch_token_expires_at,
  };

  let botAccount: BotAccountRow | null = null;

  if (senderSettings.sender_mode === 'custom_bot') {
    if (!senderSettings.custom_bot_account_id) {
      return null;
    }
    const customBotAccountId = senderSettings.custom_bot_account_id;

    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select(botAccountColumns)
            .from(twitchBotAccountsTable)
            .where(
              and(
                eq(twitchBotAccountsTable.id, customBotAccountId),
                eq(twitchBotAccountsTable.owner_type, 'streamer'),
                eq(twitchBotAccountsTable.streamer_id, streamerId),
                eq(twitchBotAccountsTable.status, 'active')
              )
            )
            .limit(1);
        },
        'getBotAccountForChat(custom bot)',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      );
      // owner_type は DB の CHECK 制約で 'streamer' | 'system' が保証されている。
      // 既存実装と同じ「型を合わせるだけのキャスト」（値の変換はしない）。
      botAccount = (rows[0] ?? null) as BotAccountRow | null;
    } catch (error) {
      if (isMissingBotSchemaErrorPg(error)) {
        logger.warn('Twitch BOT accounts table not found in schema', { broadcasterTwitchUserId });
        return null;
      }
      logger.error('Database error fetching custom BOT account', { broadcasterTwitchUserId, error });
      throw new TwitchTokenError(
        'Failed to fetch custom BOT account from database',
        'DATABASE_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  } else if (senderSettings.sender_mode === 'official_bot') {
    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select(botAccountColumns)
            .from(twitchBotAccountsTable)
            .where(
              and(
                eq(twitchBotAccountsTable.owner_type, 'system'),
                eq(twitchBotAccountsTable.status, 'active')
              )
            )
            .orderBy(asc(twitchBotAccountsTable.created_at))
            .limit(1);
        },
        'getBotAccountForChat(official bot)',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      );
      botAccount = (rows[0] ?? null) as BotAccountRow | null;
    } catch (error) {
      if (isMissingBotSchemaErrorPg(error)) {
        logger.warn('Twitch BOT accounts table not found in schema', { broadcasterTwitchUserId });
        return null;
      }
      logger.error('Database error fetching official BOT account', { broadcasterTwitchUserId, error });
      throw new TwitchTokenError(
        'Failed to fetch official BOT account from database',
        'DATABASE_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  if (!botAccount) {
    return null;
  }
  // withDbRetry の queryFn（closure）から参照するため const に固定する
  // （let のままだと TypeScript の null 除去ナローイングが closure 内へ届かない）
  const account = botAccount;

  const expiresAt = new Date(account.twitch_token_expires_at);
  if (isNaN(expiresAt.getTime())) {
    return null;
  }

  if (expiresAt > new Date()) {
    return {
      accountId: account.id,
      senderId: account.twitch_user_id,
      username: account.twitch_username,
      displayName: account.twitch_display_name,
      accessToken: account.twitch_access_token,
      ownerType: account.owner_type,
    };
  }

  try {
    const tokens = await refreshTwitchToken(account.twitch_refresh_token);
    const refreshedExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    try {
      await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .update(twitchBotAccountsTable)
            .set({
              twitch_access_token: tokens.access_token,
              twitch_refresh_token: tokens.refresh_token,
              twitch_token_expires_at: refreshedExpiresAt.toISOString(),
              scopes: tokens.scope ?? [],
              status: 'active',
              last_error: null,
            })
            .where(eq(twitchBotAccountsTable.id, account.id));
        },
        'getBotAccountForChat(save refreshed token)',
        // リトライしても同じトークン値を書く UPDATE のため冪等（リトライ可）
        { idempotent: true },
      );
    } catch (error) {
      if (!isMissingBotSchemaErrorPg(error)) {
        // 外側の catch で status:'error' 保存 + null 返却（既存経路と同じ流れ）
        throw error;
      }
      logger.warn('Twitch BOT accounts table not found in schema, returning refreshed token without saving', {
        broadcasterTwitchUserId,
      });
    }

    return {
      accountId: account.id,
      senderId: account.twitch_user_id,
      username: account.twitch_username,
      displayName: account.twitch_display_name,
      accessToken: tokens.access_token,
      ownerType: account.owner_type,
    };
  } catch (error) {
    logger.error('Failed to refresh BOT Twitch access token', { broadcasterTwitchUserId, error });
    // 既存 postgrest 経路はこの update の結果（error）を確認せず無視する（best-effort）。
    // pg 直結では失敗が throw になるため catch で握りつぶし、「必ず null を返す」
    // 同じ外部挙動に合わせる（ここで throw すると経路によって呼び出し元の挙動が変わる）。
    try {
      await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .update(twitchBotAccountsTable)
            .set({
              status: 'error',
              last_error: error instanceof Error ? error.message : String(error),
            })
            .where(eq(twitchBotAccountsTable.id, account.id));
        },
        'getBotAccountForChat(save error status)',
        // リトライしても同じ値（catch 済みエラーの文字列）を書く UPDATE のため冪等
        { idempotent: true },
      );
    } catch {
      // best-effort 書き込みの失敗は無視（既存経路がエラーを確認しないのと同等）
    }
    return null;
  }
}

export async function getBotAccountForChat(broadcasterTwitchUserId: string): Promise<BotChatAccount | null> {
  // #572: BOT トークンのリフレッシュ保存（書き込み）を含む読み書き混在関数のため、
  // isPgWriteEnabled() で関数全体を分岐する（ファイル冒頭のフラグ使い分け方針）。
  if (isPgWriteEnabled()) {
    return getBotAccountForChatPg(broadcasterTwitchUserId);
  }

  const supabaseAdmin = getSupabaseAdmin();

  const { data: streamer, error: dbError } = await supabaseAdmin
    .from('streamers')
    .select('id')
    .eq('twitch_user_id', broadcasterTwitchUserId)
    .maybeSingle();

  if (dbError) {
    logger.error('Database error fetching BOT account', { broadcasterTwitchUserId, error: dbError });
    throw new TwitchTokenError(
      'Failed to fetch BOT account from database',
      'DATABASE_ERROR',
      dbError
    );
  }

  if (!streamer) {
    return null;
  }

  const { data: senderSettings, error: settingsError } = await supabaseAdmin
    .from('streamer_chat_sender_settings')
    .select('sender_mode, custom_bot_account_id')
    .eq('streamer_id', streamer.id)
    .maybeSingle();

  if (settingsError) {
    if (isMissingBotSchemaError(settingsError)) {
      logger.warn('Chat sender settings table not found in schema', { broadcasterTwitchUserId });
      return null;
    }
    logger.error('Database error fetching chat sender settings', { broadcasterTwitchUserId, error: settingsError });
    throw new TwitchTokenError(
      'Failed to fetch chat sender settings from database',
      'DATABASE_ERROR',
      settingsError
    );
  }

  if (!senderSettings || senderSettings.sender_mode === 'streamer') {
    return null;
  }

  let botAccount: BotAccountRow | null = null;

  if (senderSettings.sender_mode === 'custom_bot') {
    if (!senderSettings.custom_bot_account_id) {
      return null;
    }

    const { data, error } = await supabaseAdmin
      .from('twitch_bot_accounts')
      .select(`
        id,
        owner_type,
        twitch_user_id,
        twitch_username,
        twitch_display_name,
        twitch_access_token,
        twitch_refresh_token,
        twitch_token_expires_at
      `)
      .eq('id', senderSettings.custom_bot_account_id)
      .eq('owner_type', 'streamer')
      .eq('streamer_id', streamer.id)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      if (isMissingBotSchemaError(error)) {
        logger.warn('Twitch BOT accounts table not found in schema', { broadcasterTwitchUserId });
        return null;
      }
      logger.error('Database error fetching custom BOT account', { broadcasterTwitchUserId, error });
      throw new TwitchTokenError('Failed to fetch custom BOT account from database', 'DATABASE_ERROR', error);
    }

    botAccount = data as BotAccountRow | null;
  } else if (senderSettings.sender_mode === 'official_bot') {
    const { data, error } = await supabaseAdmin
      .from('twitch_bot_accounts')
      .select(`
        id,
        owner_type,
        twitch_user_id,
        twitch_username,
        twitch_display_name,
        twitch_access_token,
        twitch_refresh_token,
        twitch_token_expires_at
      `)
      .eq('owner_type', 'system')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (isMissingBotSchemaError(error)) {
        logger.warn('Twitch BOT accounts table not found in schema', { broadcasterTwitchUserId });
        return null;
      }
      logger.error('Database error fetching official BOT account', { broadcasterTwitchUserId, error });
      throw new TwitchTokenError('Failed to fetch official BOT account from database', 'DATABASE_ERROR', error);
    }

    botAccount = data as BotAccountRow | null;
  }

  if (!botAccount) {
    return null;
  }

  const expiresAt = new Date(botAccount.twitch_token_expires_at);
  if (isNaN(expiresAt.getTime())) {
    return null;
  }

  if (expiresAt > new Date()) {
    return {
      accountId: botAccount.id,
      senderId: botAccount.twitch_user_id,
      username: botAccount.twitch_username,
      displayName: botAccount.twitch_display_name,
      accessToken: botAccount.twitch_access_token,
      ownerType: botAccount.owner_type,
    };
  }

  try {
    const tokens = await refreshTwitchToken(botAccount.twitch_refresh_token);
    const refreshedExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    const { error } = await supabaseAdmin
      .from('twitch_bot_accounts')
      .update({
        twitch_access_token: tokens.access_token,
        twitch_refresh_token: tokens.refresh_token,
        twitch_token_expires_at: refreshedExpiresAt.toISOString(),
        scopes: tokens.scope ?? [],
        status: 'active',
        last_error: null,
      })
      .eq('id', botAccount.id);

    if (error && !isMissingBotSchemaError(error)) {
      throw error;
    }
    if (isMissingBotSchemaError(error)) {
      logger.warn('Twitch BOT accounts table not found in schema, returning refreshed token without saving', {
        broadcasterTwitchUserId,
      });
    }

    return {
      accountId: botAccount.id,
      senderId: botAccount.twitch_user_id,
      username: botAccount.twitch_username,
      displayName: botAccount.twitch_display_name,
      accessToken: tokens.access_token,
      ownerType: botAccount.owner_type,
    };
  } catch (error) {
    logger.error('Failed to refresh BOT Twitch access token', { broadcasterTwitchUserId, error });
    await supabaseAdmin
      .from('twitch_bot_accounts')
      .update({
        status: 'error',
        last_error: error instanceof Error ? error.message : String(error),
      })
      .eq('id', botAccount.id);
    return null;
  }
}

/**
 * getCustomBotAccountDisplayForStreamer の pg 直結実装 (#572)
 *
 * 読み取り専用の関数のため isPgReadEnabled() で分岐する。
 * 既存実装はエラーを分割代入で握りつぶして null を返す（settingsError / 2 本目は
 * error 自体を受け取らない）ため、pg 版も各クエリを catch して null に落とす。
 */
async function getCustomBotAccountDisplayForStreamerPg(
  streamerId: string
): Promise<{ username: string | null; displayName: string | null } | null> {
  let settings: { sender_mode: string; custom_bot_account_id: string | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            sender_mode: streamerChatSenderSettingsTable.sender_mode,
            custom_bot_account_id: streamerChatSenderSettingsTable.custom_bot_account_id,
          })
          .from(streamerChatSenderSettingsTable)
          .where(eq(streamerChatSenderSettingsTable.streamer_id, streamerId))
          .limit(1); // streamer_id は PK（migration 00040）のため maybeSingle と同じ外部挙動
      },
      'getCustomBotAccountDisplayForStreamer(settings)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    settings = rows[0] ?? null;
  } catch {
    // 既存経路は settingsError 時に（ログなしで）null を返す。同じ外部挙動に合わせる。
    return null;
  }

  if (settings?.sender_mode !== 'custom_bot' || !settings.custom_bot_account_id) {
    return null;
  }
  const customBotAccountId = settings.custom_bot_account_id;

  let botAccount: { twitch_username: string | null; twitch_display_name: string | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            twitch_username: twitchBotAccountsTable.twitch_username,
            twitch_display_name: twitchBotAccountsTable.twitch_display_name,
          })
          .from(twitchBotAccountsTable)
          .where(
            and(
              eq(twitchBotAccountsTable.id, customBotAccountId),
              eq(twitchBotAccountsTable.owner_type, 'streamer'),
              eq(twitchBotAccountsTable.streamer_id, streamerId),
              eq(twitchBotAccountsTable.status, 'active')
            )
          )
          .limit(1); // id は PK のため maybeSingle と同じ外部挙動
      },
      'getCustomBotAccountDisplayForStreamer(bot account)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    botAccount = rows[0] ?? null;
  } catch {
    // 既存経路は error を受け取らず data=null → null を返す。同じ外部挙動に合わせる。
    return null;
  }

  if (!botAccount) {
    return null;
  }

  return {
    username: botAccount.twitch_username,
    displayName: botAccount.twitch_display_name,
  };
}

export async function getCustomBotAccountDisplayForStreamer(
  streamerId: string
): Promise<{ username: string | null; displayName: string | null } | null> {
  // #572: 読み取り専用の関数のため isPgReadEnabled() で分岐。
  if (isPgReadEnabled()) {
    return getCustomBotAccountDisplayForStreamerPg(streamerId);
  }

  const supabaseAdmin = getSupabaseAdmin();

  const { data: settings, error: settingsError } = await supabaseAdmin
    .from('streamer_chat_sender_settings')
    .select('sender_mode, custom_bot_account_id')
    .eq('streamer_id', streamerId)
    .maybeSingle();

  if (settingsError || settings?.sender_mode !== 'custom_bot' || !settings.custom_bot_account_id) {
    return null;
  }

  const { data: botAccount } = await supabaseAdmin
    .from('twitch_bot_accounts')
    .select('twitch_username, twitch_display_name')
    .eq('id', settings.custom_bot_account_id)
    .eq('owner_type', 'streamer')
    .eq('streamer_id', streamerId)
    .eq('status', 'active')
    .maybeSingle();

  if (!botAccount) {
    return null;
  }

  return {
    username: botAccount.twitch_username,
    displayName: botAccount.twitch_display_name,
  };
}

/**
 * refreshTwitchAccessToken の pg 直結実装 (#572)
 *
 * users への UPDATE（書き込み）を含む関数のため、呼び出し元は isPgWriteEnabled() で
 * 関数全体を分岐する。スコープ同期（saveTwitchScopes）は共有関数のまま呼び、その
 * 内部で再度フラグ分岐される。PGRST204（トークン列未デプロイ）のデプロイ窓
 * フォールバックは、pg 直結では UPDATE 対象列の欠落が SQLSTATE 42703 になるため
 * isPgMissingColumnError で再現する（トークン値はログに出さない既存慣習を踏襲）。
 */
async function refreshTwitchAccessTokenPg(twitchUserId: string, refreshToken: string): Promise<string> {
  try {
    const tokens = await refreshTwitchToken(refreshToken);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    try {
      await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { db } = await getDb();
          return db
            .update(usersTable)
            .set({
              twitch_access_token: tokens.access_token,
              twitch_refresh_token: tokens.refresh_token,
              twitch_token_expires_at: expiresAt.toISOString(),
            })
            .where(eq(usersTable.twitch_user_id, twitchUserId));
        },
        'refreshTwitchAccessToken(save)',
        // リトライしても同じトークン値を書く UPDATE のため冪等（リトライ可）。
        // なお、このリトライは同一呼び出し内の再送としては冪等だが、リトライ待機
        // （バックオフ合計で最大約1.4秒 = 100+300+1000ms）の間に別リクエストの並行
        // リフレッシュが新しいトークンを書き込んだ場合、古い値で上書きする競合窓を
        // 広げる側面がある。この競合自体は postgrest 経路の並行リフレッシュにも
        // 存在する既知の性質であり（検知手段のないブラインド UPDATE）、リトライ禁止に
        // すると一時障害だけで確実にトークンが失われる方が害が大きいため、リトライを
        // 許容する。根本対応（楽観ロック）は Phase 2 以降の検討事項。
        { idempotent: true },
      );
    } catch (error) {
      if (isPgMissingColumnError(error)) {
        logger.warn('Twitch token columns not found in schema, returning token without saving', { twitchUserId, error });
        return tokens.access_token;
      }
      throw error;
    }

    // リフレッシュレスポンスのスコープで DB を全置換する（best-effort）。
    // 設計判断の詳細は postgrest 経路（下の refreshTwitchAccessToken 本体）の
    // 同箇所コメントを参照（DB/トークン乖離の永続化防止のための全置換）。
    if (tokens.scope && tokens.scope.length > 0) {
      try {
        await saveTwitchScopes(twitchUserId, tokens.scope);
      } catch (scopeSaveError) {
        logger.warn('Failed to sync scopes on token refresh (best-effort)', {
          twitchUserId,
          error: scopeSaveError instanceof Error ? scopeSaveError.message : String(scopeSaveError),
        });
      }
    }

    return tokens.access_token;
  } catch (error) {
    logger.error('Failed to refresh Twitch access token', { twitchUserId, error });
    throw new TwitchTokenError(
      'Failed to refresh Twitch access token',
      'REFRESH_FAILED',
      error instanceof Error ? error : undefined
    );
  }
}

async function refreshTwitchAccessToken(twitchUserId: string, refreshToken: string): Promise<string> {
  // #572: 書き込み（users の UPDATE）を含む関数のため isPgWriteEnabled() で分岐。
  if (isPgWriteEnabled()) {
    return refreshTwitchAccessTokenPg(twitchUserId, refreshToken);
  }

  try {
    const tokens = await refreshTwitchToken(refreshToken);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    const supabaseAdmin = getSupabaseAdmin();
    const { error } = await supabaseAdmin
      .from('users')
      .update({
        twitch_access_token: tokens.access_token,
        twitch_refresh_token: tokens.refresh_token,
        twitch_token_expires_at: expiresAt.toISOString(),
      })
      .eq('twitch_user_id', twitchUserId);

    if (error) {
      // If columns don't exist (PGRST204), just return the token without saving
      if (error.code === 'PGRST204') {
        logger.warn('Twitch token columns not found in schema, returning token without saving', { twitchUserId, error });
        return tokens.access_token;
      }
      throw error;
    }

    // リフレッシュレスポンスのスコープでDBを全置換する（best-effort）
    // Twitchのrefreshレスポンスはトークンの実スコープを返す（公式ドキュメント準拠）。
    // 以前はDBスコープとマージしていたが、トークンにないスコープがDBに残ると
    // DB/トークン乖離が永続化し401エラーの原因になるため、全置換に変更。
    // callbackの自動リダイレクト機構により、追加スコープはログイン時に復元される。
    //
    // Full replace DB scopes with refresh response scopes (best-effort).
    // Twitch refresh response returns actual token scopes (per official docs).
    // Previously merged with DB scopes, but stale DB scopes cause permanent
    // DB/token divergence and repeated 401 errors. Full replace keeps DB in sync.
    // Callback's auto-redirect mechanism recovers additional scopes on login.
    if (tokens.scope && tokens.scope.length > 0) {
      try {
        await saveTwitchScopes(twitchUserId, tokens.scope);
      } catch (scopeSaveError) {
        logger.warn('Failed to sync scopes on token refresh (best-effort)', {
          twitchUserId,
          error: scopeSaveError instanceof Error ? scopeSaveError.message : String(scopeSaveError),
        });
      }
    }

    return tokens.access_token;
  } catch (error) {
    logger.error('Failed to refresh Twitch access token', { twitchUserId, error });
    throw new TwitchTokenError(
      'Failed to refresh Twitch access token',
      'REFRESH_FAILED',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * saveTwitchTokens の pg 直結実装 (#572)
 * 書き込み（users の UPDATE）のみの関数のため isPgWriteEnabled() で分岐。
 * PGRST204 相当のデプロイ窓フォールバックは 42703 (isPgMissingColumnError) で再現。
 */
async function saveTwitchTokensPg(twitchUserId: string, tokens: TwitchTokens): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .update(usersTable)
          .set({
            twitch_access_token: tokens.access_token,
            twitch_refresh_token: tokens.refresh_token,
            twitch_token_expires_at: expiresAt.toISOString(),
          })
          .where(eq(usersTable.twitch_user_id, twitchUserId));
      },
      'saveTwitchTokens',
      // リトライしても同じトークン値を書く UPDATE のため冪等（リトライ可）。
      // リトライ待機中に並行リフレッシュの新しいトークンを古い値で上書きする
      // 競合窓を広げる側面とその許容判断（リトライ禁止による確実なトークン喪失の
      // ほうが害が大きい）は refreshTwitchAccessTokenPg の同箇所コメントを参照。
      { idempotent: true },
    );
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      logger.warn('Twitch token columns not found in schema, skipping save', { twitchUserId, error });
      return;
    }
    throw error;
  }
}

export async function saveTwitchTokens(twitchUserId: string, tokens: TwitchTokens): Promise<void> {
  // #572: 書き込みのみの関数のため isPgWriteEnabled() で分岐。
  if (isPgWriteEnabled()) {
    return saveTwitchTokensPg(twitchUserId, tokens);
  }

  const supabaseAdmin = getSupabaseAdmin();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      twitch_access_token: tokens.access_token,
      twitch_refresh_token: tokens.refresh_token,
      twitch_token_expires_at: expiresAt.toISOString(),
    })
    .eq('twitch_user_id', twitchUserId);

  if (error) {
    // If columns don't exist (PGRST204), just log and return
    if (error.code === 'PGRST204') {
      logger.warn('Twitch token columns not found in schema, skipping save', { twitchUserId, error });
      return;
    }
    throw error;
  }
}

/**
 * deleteTwitchTokens の pg 直結実装 (#572)
 * 書き込み（users の UPDATE）のみの関数のため isPgWriteEnabled() で分岐。
 */
async function deleteTwitchTokensPg(twitchUserId: string): Promise<void> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .update(usersTable)
          .set({
            twitch_access_token: null,
            twitch_refresh_token: null,
            twitch_token_expires_at: null,
          })
          .where(eq(usersTable.twitch_user_id, twitchUserId));
      },
      'deleteTwitchTokens',
      // 常に同じ値（NULL）を書く UPDATE のためリトライしても冪等。
      // リトライ待機中の並行リフレッシュとの競合窓（この関数の場合は、待機中に
      // 書き込まれた新トークンを NULL で上書きする＝ログアウト意図どおりの結果に
      // なる側面が強い）とリトライ許容の判断根拠は refreshTwitchAccessTokenPg の
      // 同箇所コメントを参照。
      { idempotent: true },
    );
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      logger.warn('Twitch token columns not found in schema, skipping deletion', { twitchUserId, error });
      return;
    }
    throw error;
  }
}

export async function deleteTwitchTokens(twitchUserId: string): Promise<void> {
  // #572: 書き込みのみの関数のため isPgWriteEnabled() で分岐。
  if (isPgWriteEnabled()) {
    return deleteTwitchTokensPg(twitchUserId);
  }

  const supabaseAdmin = getSupabaseAdmin();

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      twitch_access_token: null,
      twitch_refresh_token: null,
      twitch_token_expires_at: null,
    })
    .eq('twitch_user_id', twitchUserId);

  if (error) {
    // If columns don't exist (PGRST204), just log and return
    if (error.code === 'PGRST204') {
      logger.warn('Twitch token columns not found in schema, skipping deletion', { twitchUserId, error });
      return;
    }
    throw error;
  }
}

/**
 * ユーザーが特定のTwitchスコープを持っているかチェック
 * Check if a user has a specific Twitch scope granted
 * @param twitchUserId - TwitchユーザーID
 * @param scope - 確認するスコープ（例: 'user:write:chat'）
 * @returns スコープが付与されている場合はtrue
 */
/**
 * hasScope の pg 直結実装 (#572)
 * 読み取り専用の関数のため isPgReadEnabled() で分岐。twitch_scopes は text[] 列
 * のため必ず Drizzle スキーマ経由で読む（fetch_types: false の生 SQL では配列が
 * パースされない。src/lib/db/client.ts の注意書き参照）。
 */
async function hasScopePg(twitchUserId: string, scope: string): Promise<boolean> {
  let user: { twitch_scopes: string[] | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ twitch_scopes: usersTable.twitch_scopes })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1); // twitch_user_id は UNIQUE（00001）のため maybeSingle と同じ外部挙動
      },
      'Twitch scope check',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    user = rows[0] ?? null;
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      logger.warn('twitch_scopes column not found in schema', { twitchUserId, scope });
      return false;
    }
    logger.error('Database error checking scope', { twitchUserId, scope, error });
    return false;
  }

  // twitch_scopesがnullまたは空配列の場合、追加スコープは付与されていない
  // If twitch_scopes is null or empty, no additional scopes have been granted
  if (!user?.twitch_scopes || user.twitch_scopes.length === 0) {
    return false;
  }

  return user.twitch_scopes.includes(scope);
}

export async function hasScope(twitchUserId: string, scope: string): Promise<boolean> {
  // #572: 読み取り専用の関数のため isPgReadEnabled() で分岐。
  if (isPgReadEnabled()) {
    return hasScopePg(twitchUserId, scope);
  }

  const supabaseAdmin = getSupabaseAdmin();

  const { data: user, error } = await withRetry(
    () => supabaseAdmin
      .from('users')
      .select('twitch_scopes')
      .eq('twitch_user_id', twitchUserId)
      .maybeSingle(),
    'Twitch scope check',
  );

  if (error) {
    // PGRST204 means column not found - twitch_scopes column may not exist
    if (error.code === 'PGRST204') {
      logger.warn('twitch_scopes column not found in schema', { twitchUserId, scope });
      return false;
    }
    // maybeSingle()を使用しているため、行が見つからない場合はerrorではなくdata=nullが返る
    logger.error('Database error checking scope', { twitchUserId, scope, error });
    return false;
  }

  // twitch_scopesがnullまたは空配列の場合、追加スコープは付与されていない
  // If twitch_scopes is null or empty, no additional scopes have been granted
  if (!user?.twitch_scopes || user.twitch_scopes.length === 0) {
    return false;
  }

  return user.twitch_scopes.includes(scope);
}

/**
 * ユーザーのTwitchスコープから特定のスコープを削除する
 * トークンが実際にはスコープを持っていないことが判明した場合（401エラー等）に使用
 * Remove a specific scope from a user's Twitch scopes in the database.
 * Used when it's discovered the token doesn't actually have the scope (e.g., 401 error)
 * @param twitchUserId - TwitchユーザーID
 * @param scope - 削除するスコープ（例: 'user:write:chat'）
 */
/**
 * removeScope の pg 直結実装 (#572)
 * 読み取り（現在のスコープ取得）と書き込み（除外後の全置換 UPDATE）が混在する
 * 関数のため、呼び出し元は isPgWriteEnabled() で関数全体を分岐する。
 * 既存実装はどのエラーでも throw せず静かに return するため、pg 版も同じ。
 */
async function removeScopePg(twitchUserId: string, scope: string): Promise<void> {
  let user: { twitch_scopes: string[] | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ twitch_scopes: usersTable.twitch_scopes })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      'removeScope(fetch)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    user = rows[0] ?? null;
  } catch (fetchError) {
    if (isPgMissingColumnError(fetchError)) {
      return;
    }
    logger.error('Failed to fetch scopes for removal', { twitchUserId, scope, error: fetchError });
    return;
  }

  if (!user?.twitch_scopes || !user.twitch_scopes.includes(scope)) {
    return;
  }

  // 指定スコープを除外した配列で更新
  // Update with the scope filtered out
  const updatedScopes = user.twitch_scopes.filter((s: string) => s !== scope);

  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .update(usersTable)
          .set({ twitch_scopes: updatedScopes })
          .where(eq(usersTable.twitch_user_id, twitchUserId));
      },
      'removeScope(update)',
      // 事前計算した同じ配列を書く全置換 UPDATE のためリトライしても冪等
      { idempotent: true },
    );
  } catch (updateError) {
    if (isPgMissingColumnError(updateError)) {
      return;
    }
    logger.error('Failed to remove scope', { twitchUserId, scope, error: updateError });
    return;
  }

  logger.info('Removed invalid scope from user', {
    twitchUserId,
    removedScope: scope,
    remainingScopes: updatedScopes,
  });
}

export async function removeScope(twitchUserId: string, scope: string): Promise<void> {
  // #572: 読み取りと書き込みが混在する関数のため isPgWriteEnabled() で関数全体を分岐。
  if (isPgWriteEnabled()) {
    return removeScopePg(twitchUserId, scope);
  }

  const supabaseAdmin = getSupabaseAdmin();

  const { data: user, error: fetchError } = await supabaseAdmin
    .from('users')
    .select('twitch_scopes')
    .eq('twitch_user_id', twitchUserId)
    .maybeSingle();

  if (fetchError) {
    if (fetchError.code === 'PGRST204') {
      return;
    }
    logger.error('Failed to fetch scopes for removal', { twitchUserId, scope, error: fetchError });
    return;
  }

  if (!user?.twitch_scopes || !user.twitch_scopes.includes(scope)) {
    return;
  }

  // 指定スコープを除外した配列で更新
  // Update with the scope filtered out
  const updatedScopes = user.twitch_scopes.filter((s: string) => s !== scope);

  const { error: updateError } = await supabaseAdmin
    .from('users')
    .update({ twitch_scopes: updatedScopes })
    .eq('twitch_user_id', twitchUserId);

  if (updateError) {
    if (updateError.code === 'PGRST204') {
      return;
    }
    logger.error('Failed to remove scope', { twitchUserId, scope, error: updateError });
    return;
  }

  logger.info('Removed invalid scope from user', {
    twitchUserId,
    removedScope: scope,
    remainingScopes: updatedScopes,
  });
}

/**
 * ユーザーのTwitchスコープをデータベースに保存（全置換）
 * 通常ログイン・再認証フロー双方から呼ばれる。
 * トークンの実スコープでDBを全置換することでDB/トークン乖離を防ぐ。
 * Save Twitch scopes to database for a user (full replace).
 * Called from both regular login and re-auth flows.
 * Full replace keeps DB in sync with actual token scopes, preventing divergence.
 * @param twitchUserId - TwitchユーザーID
 * @param scopes - 保存するスコープの配列
 */
/**
 * saveTwitchScopes の pg 直結実装 (#572)
 * 書き込み（users の UPDATE）のみの関数のため isPgWriteEnabled() で分岐。
 */
async function saveTwitchScopesPg(twitchUserId: string, scopes: string[]): Promise<void> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .update(usersTable)
          .set({
            twitch_scopes: scopes,
          })
          .where(eq(usersTable.twitch_user_id, twitchUserId));
      },
      'saveTwitchScopes',
      // 同じ配列を書く全置換 UPDATE のためリトライしても冪等
      { idempotent: true },
    );
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      logger.warn('twitch_scopes column not found in schema, skipping save', { twitchUserId, error });
      return;
    }
    logger.error('Failed to save Twitch scopes', { twitchUserId, scopes, error });
    throw error;
  }

  logger.info('Saved Twitch scopes for user', { twitchUserId, scopeCount: scopes.length });
}

export async function saveTwitchScopes(twitchUserId: string, scopes: string[]): Promise<void> {
  // #572: 書き込みのみの関数のため isPgWriteEnabled() で分岐。
  if (isPgWriteEnabled()) {
    return saveTwitchScopesPg(twitchUserId, scopes);
  }

  const supabaseAdmin = getSupabaseAdmin();

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      twitch_scopes: scopes,
    })
    .eq('twitch_user_id', twitchUserId);

  if (error) {
    // PGRST204 means column not found - twitch_scopes column may not exist yet
    if (error.code === 'PGRST204') {
      logger.warn('twitch_scopes column not found in schema, skipping save', { twitchUserId, error });
      return;
    }
    logger.error('Failed to save Twitch scopes', { twitchUserId, scopes, error });
    throw error;
  }

  logger.info('Saved Twitch scopes for user', { twitchUserId, scopeCount: scopes.length });
}

/**
 * Twitch /oauth2/validate でトークンの実スコープを取得する
 * check-scope APIからの参照用（DB更新は行わない、read-only）
 * Fetch actual token scopes from Twitch /oauth2/validate endpoint.
 * Read-only: used by check-scope API to detect DB/token divergence without modifying DB.
 * @param twitchUserId - TwitchユーザーID
 * @returns スコープ配列、トークン無効時は空配列、判定不能時はnull
 */
/**
 * validateTokenScopes の pg 直結実装 (#572)
 *
 * DB アクセスは読み取りのみ（リフレッシュも書き込みも行わない read-only 契約）の
 * 関数のため isPgReadEnabled() で分岐。DB 読み取り以降の Twitch /oauth2/validate
 * 呼び出しと判定ロジックは既存実装と同一（コメントの設計判断も同じ）。
 */
async function validateTokenScopesPg(twitchUserId: string): Promise<string[] | null> {
  try {
    let user: { twitch_access_token: string | null; twitch_token_expires_at: string | null } | null;
    try {
      const rows = await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { db } = await getDb();
          return db
            .select({
              twitch_access_token: usersTable.twitch_access_token,
              twitch_token_expires_at: usersTable.twitch_token_expires_at,
            })
            .from(usersTable)
            .where(eq(usersTable.twitch_user_id, twitchUserId))
            .limit(1);
        },
        'twitch token scope validation fetch',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      );
      user = rows[0] ?? null;
    } catch {
      // 既存経路は dbError 時に（ログなしで）null を返し、呼び出し元に DB 信頼を委ねる
      return null;
    }

    if (!user?.twitch_access_token) return null;

    // トークンがローカルで期限切れなら Twitch API を叩かず null を返す
    // （設計判断の詳細は postgrest 経路の同箇所コメントを参照）
    if (user.twitch_token_expires_at) {
      const expiresAt = new Date(user.twitch_token_expires_at);
      if (!isNaN(expiresAt.getTime()) && expiresAt <= new Date()) {
        return null;
      }
    }

    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${user.twitch_access_token}` },
    });

    // 401/403（期限内トークンに対して）= revoke 等の無効化 → 空配列で乖離検出
    if (response.status === 401 || response.status === 403) {
      return [];
    }
    // ネットワークエラー/5xx = 判定不能 → null で呼び出し元に DB 信頼を委ねる
    if (!response.ok) return null;

    const data = await response.json();
    return data.scopes ?? [];
  } catch (error) {
    // DB エラー/ネットワーク例外時 → null で呼び出し元に DB 信頼を委ねる
    logger.warn('Failed to validate token scopes', {
      twitchUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function validateTokenScopes(twitchUserId: string): Promise<string[] | null> {
  // #572: DB アクセスは読み取りのみ（read-only 契約）の関数のため isPgReadEnabled() で分岐。
  if (isPgReadEnabled()) {
    return validateTokenScopesPg(twitchUserId);
  }

  try {
    // DBからトークンと有効期限を直接読み取る（リフレッシュしない）
    // check-scope GETはread-onlyであるべきなので、getTwitchAccessToken()は使わない
    // getTwitchAccessToken()は期限切れ時にリフレッシュ→DB書き込みを行うため
    // Read token and expiry from DB without triggering refresh.
    // check-scope GET must be read-only; getTwitchAccessToken() would refresh expired
    // tokens and write to DB, violating the read-only contract.
    const supabaseAdmin = getSupabaseAdmin();
    const { data: user, error: dbError } = await withRetry(
      () => supabaseAdmin
        .from('users')
        .select('twitch_access_token, twitch_token_expires_at')
        .eq('twitch_user_id', twitchUserId)
        .maybeSingle(),
      'twitch token scope validation fetch',
    );

    if (dbError || !user?.twitch_access_token) return null;

    // トークンがローカルで期限切れならTwitch APIを叩かずnullを返す。
    // 期限切れは通常の状態であり、スコープ失効とは異なる。
    // nullを返すことでcheck-scope APIはDB側の結果を信頼する。
    // 実際にスコープを使う機能(chat送信、sub確認)側で401時に個別対処される。
    // If token is locally expired, return null without hitting Twitch API.
    // Expiry is normal operation, not scope revocation. Returning null lets
    // check-scope API trust the DB result. Actual scope usage (chat, sub check)
    // handles 401 individually when the feature is invoked.
    if (user.twitch_token_expires_at) {
      const expiresAt = new Date(user.twitch_token_expires_at);
      if (!isNaN(expiresAt.getTime()) && expiresAt <= new Date()) {
        return null;
      }
    }

    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${user.twitch_access_token}` },
    });

    // 401/403（期限内トークンに対して）= revoke等の無効化 → 空配列で乖離検出
    // 401/403 on a non-expired token = revoked/invalidated → return empty array
    if (response.status === 401 || response.status === 403) {
      return [];
    }
    // ネットワークエラー/5xx = 判定不能 → nullで呼び出し元にDB信頼を委ねる
    // Network error/5xx = unable to determine → return null so caller falls back to DB
    if (!response.ok) return null;

    const data = await response.json();
    return data.scopes ?? [];
  } catch (error) {
    // DBエラー/ネットワーク例外時 → nullで呼び出し元にDB信頼を委ねる
    // On DB error/network exception → return null so caller falls back to DB
    logger.warn('Failed to validate token scopes', {
      twitchUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
