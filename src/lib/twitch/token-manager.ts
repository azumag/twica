import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { refreshTwitchToken, type TwitchTokens } from './auth';
import { logger } from '@/lib/logger';

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

export async function getTwitchAccessToken(twitchUserId: string): Promise<string | null> {
  const supabaseAdmin = getSupabaseAdmin();

  const { data: user, error: dbError } = await supabaseAdmin
    .from('users')
    .select('twitch_access_token, twitch_refresh_token, twitch_token_expires_at')
    .eq('twitch_user_id', twitchUserId)
    .maybeSingle();

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

export async function getBotAccountForChat(broadcasterTwitchUserId: string): Promise<BotChatAccount | null> {
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

export async function getCustomBotAccountDisplayForStreamer(
  streamerId: string
): Promise<{ username: string | null; displayName: string | null } | null> {
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

async function refreshTwitchAccessToken(twitchUserId: string, refreshToken: string): Promise<string> {
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

export async function saveTwitchTokens(twitchUserId: string, tokens: TwitchTokens): Promise<void> {
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

export async function deleteTwitchTokens(twitchUserId: string): Promise<void> {
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
export async function hasScope(twitchUserId: string, scope: string): Promise<boolean> {
  const supabaseAdmin = getSupabaseAdmin();

  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('twitch_scopes')
    .eq('twitch_user_id', twitchUserId)
    .maybeSingle();

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
export async function removeScope(twitchUserId: string, scope: string): Promise<void> {
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
export async function saveTwitchScopes(twitchUserId: string, scopes: string[]): Promise<void> {
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
export async function validateTokenScopes(twitchUserId: string): Promise<string[] | null> {
  try {
    // DBからトークンと有効期限を直接読み取る（リフレッシュしない）
    // check-scope GETはread-onlyであるべきなので、getTwitchAccessToken()は使わない
    // getTwitchAccessToken()は期限切れ時にリフレッシュ→DB書き込みを行うため
    // Read token and expiry from DB without triggering refresh.
    // check-scope GET must be read-only; getTwitchAccessToken() would refresh expired
    // tokens and write to DB, violating the read-only contract.
    const supabaseAdmin = getSupabaseAdmin();
    const { data: user, error: dbError } = await supabaseAdmin
      .from('users')
      .select('twitch_access_token, twitch_token_expires_at')
      .eq('twitch_user_id', twitchUserId)
      .maybeSingle();

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
