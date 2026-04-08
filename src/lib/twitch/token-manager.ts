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

    // リフレッシュレスポンスにスコープが含まれていればDBとマージ同期（best-effort）
    // リフレッシュトークンのレスポンスにはデフォルトスコープしか含まれない場合がある
    // (例: 別端末ログインでuser:write:chatなしでリフレッシュされたトークン)
    // 全置換するとDBの追加スコープが消失するため、既存スコープとマージする
    // Best-effort scope merge on token refresh. Refresh response may only contain
    // default scopes (e.g., token refreshed after login from another device without
    // user:write:chat). Full replace would wipe additional scopes, so merge with existing.
    if (tokens.scope && tokens.scope.length > 0) {
      try {
        const existingScopes = await getExistingScopes(twitchUserId);
        // トークンの実スコープとDBの既存スコープをマージ（重複除去）
        const mergedScopes = [...new Set([...tokens.scope, ...existingScopes])];
        await saveTwitchScopes(twitchUserId, mergedScopes);
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
 * ユーザーの既存Twitchスコープを取得する（内部ヘルパー）
 * refreshTwitchAccessTokenでのマージ同期用
 * Get existing Twitch scopes for a user (internal helper for merge sync on refresh)
 */
async function getExistingScopes(twitchUserId: string): Promise<string[]> {
  const supabaseAdmin = getSupabaseAdmin();
  const { data: user, error } = await supabaseAdmin
    .from('users')
    .select('twitch_scopes')
    .eq('twitch_user_id', twitchUserId)
    .maybeSingle();

  if (error || !user?.twitch_scopes) return [];
  return user.twitch_scopes;
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
