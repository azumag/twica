import { refreshTwitchToken, TwitchTokenRefreshError, type TwitchTokens } from './auth';
import { logger } from '@/lib/logger.server';
// -----------------------------------------------------------------------------
// Twitch credential・scope・BOT設定はPlanetScale/Drizzleの単一経路。
// getDb()は接続回復を有効にするためwithDbRetryのqueryFn内で取得する。
// timestamptzはdb/client.tsでISO 8601へ正規化され、期限判定はnew Date()経由。
// -----------------------------------------------------------------------------
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';

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

// Workersのfetch/DB I/Oはrequest contextに所属するため、pending Promiseをmodule
// scopeへ保存して別requestからawaitしてはいけない。各request内でTwitch refreshを
// 完結させ、保存時に「交換へ使った旧refresh token」を条件とするDB CASで競合を解決する。
// CAS loserはwinnerのaccess tokenを再読込するため、ローテーション済み資格情報を
// 上書きしない。Cloudflare公式どおりtransactionへ外部APIを含めず、Hyperdrive接続を
// provider待ちの間pinしない。
function shouldDisableBotCredential(error: unknown): boolean {
  // Twitch が資格情報の失効を示す400/401だけを再認証対象にする。403/404/501等は
  // client設定・WAF・上流機能の問題でも起こるため、単にretry対象外という理由だけで
  // BOTを無効化してはいけない（retry方針とcredential失効判定は別の責務）。
  // 522/network/壊れた2xx応答やDB保存障害でstatus='error'にすると、取得クエリの
  // active filterから外れ、上流復旧後も自動再試行できなくなる。
  return error instanceof TwitchTokenRefreshError
    && error.kind === 'http'
    && (error.status === 400 || error.status === 401);
}

/**
 * getTwitchAccessToken の pg 直結実装 (#572)
 *
 * - users を twitch_user_id で 1 行取得。UNIQUE 制約（migration 00001）により
 *   最大 1 行なので、LIMIT 1 + rows[0] ?? null とする。
 * - トークン列追加 migration よりコードが先行する窓では SQLSTATE 42703 を
 *   warn + null とし、「トークン無し」の安全側へ倒す。
 * - 取得後の期限判定は既存実装と同一ロジック。期限切れ時の refreshTwitchAccessToken は
 *   共有関数のまま呼ぶ。
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
      logger.error('Twitch token columns are missing; denying token access', {
        twitchUserId,
        error: dbError,
      });
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
  // 読み取りから期限切れ時のCAS更新までPlanetScaleの単一経路で完結させる。
  return getTwitchAccessTokenPg(twitchUserId);
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



/** PostgreSQL が返す 42703 (undefined_column) / 42P01 (undefined_table) を判定する。 */
function isMissingBotSchemaErrorPg(error: unknown): boolean {
  return isPgMissingColumnError(error) || isPgMissingTableError(error);
}

/**
 * getBotAccountForChat のPlanetScale実装。
 *
 * 読み取り（streamers / streamer_chat_sender_settings / twitch_bot_accounts）と
 * 書き込み（リフレッシュ後のトークン保存・エラーステータス保存）を同じ
 * PlanetScale接続へ固定し、認証情報が別DBへ分断されないようにする。
 *
 * - 各 .maybeSingle() は一意条件（streamers.twitch_user_id UNIQUE /
 *   streamer_chat_sender_settings.streamer_id PK / twitch_bot_accounts.id PK）
 *   で取得するため LIMIT 1 + rows[0] ?? null とする。official_bot は
 *   created_at昇順の先頭を正本として選ぶ。
 * - BOTスキーマ未配備はSQLSTATE 42703/42P01で検知し、安全側へ縮退する。
 * - トークン値はログに出さない。
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
      logger.error('Chat sender settings schema is missing; disabling BOT chat sender', {
        broadcasterTwitchUserId,
        error: settingsError,
      });
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

  // 認証と送信に必要な8列だけを取得し、不要なcredential露出を避ける。
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
        logger.error('Twitch BOT accounts schema is missing; disabling custom BOT sender', {
          broadcasterTwitchUserId,
          error,
        });
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
        logger.error('Twitch BOT accounts schema is missing; disabling official BOT sender', {
          broadcasterTwitchUserId,
          error,
        });
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
    let accessToken = tokens.access_token;

    try {
      const updated = await withDbRetry(
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
            .where(and(
              eq(twitchBotAccountsTable.id, account.id),
              eq(twitchBotAccountsTable.twitch_refresh_token, account.twitch_refresh_token),
            ))
            .returning({ twitch_access_token: twitchBotAccountsTable.twitch_access_token });
        },
        'getBotAccountForChat(save refreshed token)',
        // 旧refresh token条件付きCASなので、isolate間競合や接続断後の再試行でも
        // 後勝ちの古い資格情報が新しいローテーション結果を上書きしない。
        { idempotent: true },
      );
      if (updated.length === 0) {
        const winner = await withDbRetry(
          async () => {
            const { db } = await getDb();
            return db
              .select({ twitch_access_token: twitchBotAccountsTable.twitch_access_token })
              .from(twitchBotAccountsTable)
              .where(eq(twitchBotAccountsTable.id, account.id))
              .limit(1);
          },
          'getBotAccountForChat(read CAS winner)',
          { idempotent: true },
        );
        const winnerAccessToken = winner[0]?.twitch_access_token;
        if (!winnerAccessToken) {
          throw new Error('Concurrent BOT token refresh winner is unavailable');
        }
        accessToken = winnerAccessToken;
      }
    } catch (error) {
      if (isMissingBotSchemaErrorPg(error)) {
        // 保存できない一時tokenを返すと次回も失効済みcredentialを読み直す。安全な
        // fallbackがないため、schema不整合を成功扱いせず外側でnullへ縮退する。
        logger.error('Twitch BOT schema is missing; refusing to return an unpersisted refreshed token', {
          broadcasterTwitchUserId,
          error,
        });
      }
      throw error;
    }

    return {
      accountId: account.id,
      senderId: account.twitch_user_id,
      username: account.twitch_username,
      displayName: account.twitch_display_name,
      accessToken,
      ownerType: account.owner_type,
    };
  } catch (error) {
    // Token endpoint 本文や下位例外は永続化せず、固定理由だけを1回記録する。
    logger.error('Failed to refresh BOT Twitch access token', {
      broadcasterTwitchUserId,
      accountId: account.id,
    });
    if (shouldDisableBotCredential(error)) {
      try {
        await withDbRetry(
          async () => {
            const { db } = await getDb();
            return db
              .update(twitchBotAccountsTable)
              .set({ status: 'error', last_error: 'token_refresh_failed' })
              .where(and(
                eq(twitchBotAccountsTable.id, account.id),
                eq(twitchBotAccountsTable.twitch_refresh_token, account.twitch_refresh_token),
              ));
          },
          'getBotAccountForChat(save error status)',
          { idempotent: true },
        );
      } catch {
        // best-effort。状態保存失敗でchat呼び出しへ追加例外を持ち込まない。
      }
    }
    return null;
  }
}

export async function getBotAccountForChat(broadcasterTwitchUserId: string): Promise<BotChatAccount | null> {
  // BOT設定・token refresh・CAS保存はPlanetScaleの同じrequest内で完結させる。
  return getBotAccountForChatPg(broadcasterTwitchUserId);
}

/**
 * getCustomBotAccountDisplayForStreamer のPlanetScale実装。
 *
 * 表示補助はDB障害時に認証処理を止めない契約のため、各クエリをcatchしてnullへ落とす。
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
    // 表示補助の失敗は呼び出し元の設定画面を止めず、未設定表示へ縮退する。
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
    // BOT表示名を取得できない場合は未設定表示へ縮退する。
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
  return getCustomBotAccountDisplayForStreamerPg(streamerId);
}

/**
 * refreshTwitchAccessToken の pg 直結実装 (#572)
 *
 * tokenとscopeは同じCAS UPDATEへ統合し、OAuth callbackが
 * 並行して保存した新しいtoken/scopeを旧refresh結果の後続UPDATEで上書きしない。
 * トークン列未配備のデプロイ窓は SQLSTATE 42703 を
 * isPgMissingColumnError で判定する（トークン値はログに出さない）。
 */
async function refreshTwitchAccessTokenPg(twitchUserId: string, refreshToken: string): Promise<string> {
  try {
    const tokens = await refreshTwitchToken(refreshToken);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    let accessToken = tokens.access_token;

    try {
      const updated = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .update(usersTable)
            .set({
              twitch_access_token: tokens.access_token,
              twitch_refresh_token: tokens.refresh_token,
              twitch_token_expires_at: expiresAt.toISOString(),
              twitch_scopes: tokens.scope ?? [],
            })
            // 交換に使った旧refresh tokenがまだ現行値の場合だけtoken/scopeを保存する。
            // DB retryで1回目が成功済みでも2回目は0件となり、winnerを再取得できる。
            .where(and(
              eq(usersTable.twitch_user_id, twitchUserId),
              eq(usersTable.twitch_refresh_token, refreshToken),
            ))
            .returning({ twitch_access_token: usersTable.twitch_access_token });
        },
        'refreshTwitchAccessToken(save)',
        // CASは再実行時に旧値が一致しなくなるため、接続断後も安全に再試行できる。
        { idempotent: true },
      );

      if (updated.length === 0) {
        const winner = await withDbRetry(
          async () => {
            const { db } = await getDb();
            return db
              .select({ twitch_access_token: usersTable.twitch_access_token })
              .from(usersTable)
              .where(eq(usersTable.twitch_user_id, twitchUserId))
              .limit(1);
          },
          'refreshTwitchAccessToken(read CAS winner)',
          { idempotent: true },
        );
        const winnerAccessToken = winner[0]?.twitch_access_token;
        if (!winnerAccessToken) {
          throw new Error('Concurrent Twitch token refresh winner is unavailable');
        }
        accessToken = winnerAccessToken;
      }
    } catch (error) {
      if (isPgMissingColumnError(error)) {
        // ローテーション後のtokenを保存せず返すと永続状態と不整合になるため、
        // schema欠落は成功扱いせず再認証へ誘導する。
        logger.error('Twitch token columns are missing; refusing to return an unpersisted token', {
          twitchUserId,
          error,
        });
      }
      throw error;
    }

    return accessToken;
  } catch {
    // 永続化責任は bootstrap/rewards/callback 等の API 境界に統一する。ここで
    // logger.error を使うと同じ例外を下位層と境界の双方が errors へ書く。
    logger.warn('Failed to refresh Twitch access token', { twitchUserId });
    throw new TwitchTokenError(
      'Failed to refresh Twitch access token',
      'REFRESH_FAILED'
    );
  }
}

async function refreshTwitchAccessToken(twitchUserId: string, refreshToken: string): Promise<string> {
  return refreshTwitchAccessTokenPg(twitchUserId, refreshToken);
}

/**
 * saveTwitchTokens のPlanetScale実装。
 * 列未配備のデプロイ窓は 42703 (isPgMissingColumnError) で判定する。
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
      // token保存に安全な代替先はない。成功として返すとログイン完了後にtokenが
      // 消失するため、schema欠落を明示して呼び出し元の認証処理をfail-closedにする。
      logger.error('Twitch token columns are missing; token save failed closed', {
        twitchUserId,
        error,
      });
    }
    throw error;
  }
}

export async function saveTwitchTokens(twitchUserId: string, tokens: TwitchTokens): Promise<void> {
  return saveTwitchTokensPg(twitchUserId, tokens);
}

/**
 * deleteTwitchTokens のPlanetScale実装。
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
      // logout時の削除を成功扱いすると有効なcredentialがDBに残る。セキュリティ
      // 境界なので、schema不整合は必ず呼び出し元へ伝播させる。
      logger.error('Twitch token columns are missing; token deletion failed closed', {
        twitchUserId,
        error,
      });
    }
    throw error;
  }
}

export async function deleteTwitchTokens(twitchUserId: string): Promise<void> {
  return deleteTwitchTokensPg(twitchUserId);
}

/**
 * ユーザーが特定のTwitchスコープを持っているかチェック
 * Check if a user has a specific Twitch scope granted
 * @param twitchUserId - TwitchユーザーID
 * @param scope - 確認するスコープ（例: 'user:write:chat'）
 * @returns スコープが付与されている場合はtrue
 */
/**
 * hasScope のPlanetScale実装。
 * twitch_scopes は text[] 列のため必ずDrizzleスキーマ経由で読む
 * （fetch_types: false の生SQLでは配列が
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
      logger.error('twitch_scopes column is missing; denying scope access', {
        twitchUserId,
        scope,
        error,
      });
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
  return hasScopePg(twitchUserId, scope);
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
 * removeScope のPlanetScale実装。
 * 読み取り（現在のスコープ取得）と書き込み（除外後の全置換 UPDATE）が混在する
 * ため、両方を同じDB接続へ固定する。一般DB障害は権限表示を安全側へ倒すため
 * 静かにreturnし、schema欠落だけはデプロイ不整合として伝播する。
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
      // 無効と判明したscopeを削除できない状態を成功扱いしない。呼び出し元へ
      // 伝播させ、権限状態の乖離を監視・再試行できるようにする。
      logger.error('twitch_scopes column is missing; scope removal failed closed', {
        twitchUserId,
        scope,
        error: fetchError,
      });
      throw fetchError;
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
      logger.error('twitch_scopes column is missing; scope removal update failed closed', {
        twitchUserId,
        scope,
        error: updateError,
      });
      throw updateError;
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
  return removeScopePg(twitchUserId, scope);
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
 * saveTwitchScopes のPlanetScale実装。
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
      // 実tokenのscopeとの全置換に失敗したまま成功を返すと、DB上の権限表示が
      // 恒久的に誤る。schema欠落はlogger.errorへ残して呼び出し元へ伝播する。
      logger.error('twitch_scopes column is missing; scope save failed closed', {
        twitchUserId,
        error,
      });
    }
    logger.error('Failed to save Twitch scopes', { twitchUserId, scopes, error });
    throw error;
  }

  logger.info('Saved Twitch scopes for user', { twitchUserId, scopeCount: scopes.length });
}

export async function saveTwitchScopes(twitchUserId: string, scopes: string[]): Promise<void> {
  return saveTwitchScopesPg(twitchUserId, scopes);
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
 * validateTokenScopes のPlanetScale実装。
 *
 * DBアクセスは読み取りのみで、リフレッシュも書き込みも行わない。
 * ローカル期限を確認してからTwitch /oauth2/validateを呼び、不要な外部I/Oを避ける。
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

    // ローカルで期限切れならTwitch APIを叩かず、判定不能としてnullを返す。
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
  return validateTokenScopesPg(twitchUserId);
}
