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
 * 再認証時に使用: ユーザーが明示的にスコープを選択した結果を保存する
 * Save Twitch scopes to database for a user (full replace)
 * Used during re-authentication: saves the user's explicit scope selection
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

