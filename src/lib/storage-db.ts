/**
 * Database-based Storage Usage Management
 * DB経由でストレージ使用量を管理
 *
 * Vercel Blobの list() 操作を避けるため、使用量をDBで追跡する
 * これにより操作数制限（2,000/月）を大幅に節約できる
 */

import { cache } from 'react';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { UPLOAD_CONFIG, VOTE_CAMPAIGN_CONFIG } from './constants';
import { logger } from './logger';

// グローバル使用量を識別する特殊プレフィックス
const GLOBAL_PREFIX = '_global_';

export interface StorageUsageResult {
  userUsage: number;
  globalUsage: number;
  userLimitReached: boolean;
  globalLimitReached: boolean;
  userLimitBytes: number;
  globalLimitBytes: number;
}

export interface BlobFileInfo {
  userPrefix: string;
  fileSize: number;
  storageType: 'r2' | 'vercel';
}

/**
 * DBからストレージ使用量を取得
 * Vercel Blobの list() を使わずに使用量を計算
 *
 * @param userPrefix - ユーザー識別用のプレフィックス（8文字のハッシュ）
 * @returns ストレージ使用量情報
 */
export async function getStorageUsageFromDB(userPrefix: string): Promise<StorageUsageResult> {
  try {
    const supabaseAdmin = getSupabaseAdmin();

    // ユーザーとグローバルの使用量を同時に取得
    const { data, error } = await supabaseAdmin
      .from('storage_usage')
      .select('user_prefix, bytes_used')
      .in('user_prefix', [userPrefix, GLOBAL_PREFIX]);

    if (error) {
      logger.error('[StorageDB] Failed to get storage usage:', error);
      throw new Error(`Failed to get storage usage: ${error.message}`);
    }

    // 結果を解析
    const userRow = data?.find(r => r.user_prefix === userPrefix);
    const globalRow = data?.find(r => r.user_prefix === GLOBAL_PREFIX);

    const userUsage = userRow?.bytes_used ?? 0;
    const globalUsage = globalRow?.bytes_used ?? 0;

    logger.info(`[StorageDB] Usage - User: ${userPrefix} = ${userUsage} bytes, Global = ${globalUsage} bytes`);

    return {
      userUsage,
      globalUsage,
      userLimitReached: userUsage >= UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitReached: globalUsage >= UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    };
  } catch (error) {
    // 使用量を確認できない場合は、アップロードをブロックしないように制限に達していないと仮定
    // ただし、エラーログは出力する
    logger.error('[StorageDB] Failed to get storage usage, returning defaults:', error);
    return {
      userUsage: 0,
      globalUsage: 0,
      userLimitReached: false,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    };
  }
}

/**
 * ファイル情報をDBに記録（アップロード時）
 * 使用量テーブルも同時に更新する
 *
 * @param url - アップロードされたファイルのURL
 * @param userPrefix - ユーザー識別用のプレフィックス
 * @param fileSize - ファイルサイズ（バイト）
 * @param storageType - ストレージの種類 ('r2' or 'vercel')
 */
export async function recordBlobFile(
  url: string,
  userPrefix: string,
  fileSize: number,
  storageType: 'r2' | 'vercel'
): Promise<void> {
  try {
    const supabaseAdmin = getSupabaseAdmin();

    // ファイル情報を記録
    const { error: insertError } = await supabaseAdmin
      .from('blob_files')
      .insert({
        url,
        user_prefix: userPrefix,
        file_size: fileSize,
        storage_type: storageType,
      });

    if (insertError) {
      logger.error('[StorageDB] Failed to insert blob file record:', insertError);
      throw new Error(`Failed to record blob file: ${insertError.message}`);
    }

    // 使用量を更新（ユーザーとグローバル）
    // Supabaseの rpc() を使ってストアドファンクションを呼び出す
    const { error: rpcError } = await supabaseAdmin.rpc('update_storage_usage', {
      p_user_prefix: userPrefix,
      p_size_delta: fileSize,
      p_count_delta: 1,
    });

    if (rpcError) {
      logger.error('[StorageDB] Failed to update storage usage:', rpcError);
      // ファイル記録は成功したが使用量更新が失敗した場合、ログを出すが例外は投げない
      // 次回の計算で補正される
    }

    logger.info(`[StorageDB] Recorded blob file: ${url}, size: ${fileSize}, type: ${storageType}`);
  } catch (error) {
    logger.error('[StorageDB] Error recording blob file:', error);
    throw error;
  }
}

/**
 * ファイル情報を取得して削除（削除時）
 * 使用量テーブルも同時に更新する
 *
 * @param url - 削除するファイルのURL
 * @returns ファイル情報（userPrefix, fileSize, storageType）、存在しない場合はnull
 */
export async function removeBlobFile(url: string): Promise<BlobFileInfo | null> {
  try {
    const supabaseAdmin = getSupabaseAdmin();

    // ファイル情報を取得
    const { data, error: selectError } = await supabaseAdmin
      .from('blob_files')
      .select('user_prefix, file_size, storage_type')
      .eq('url', url)
      .maybeSingle();

    // maybeSingle()を使用しているため、行が見つからない場合はerrorではなくdata=nullが返る
    if (selectError) {
      logger.error('[StorageDB] Failed to get blob file record:', selectError);
      throw new Error(`Failed to get blob file: ${selectError.message}`);
    }

    if (!data) {
      logger.warn(`[StorageDB] Blob file not found in DB: ${url}`);
      return null;
    }

    // ファイル情報を削除
    const { error: deleteError } = await supabaseAdmin
      .from('blob_files')
      .delete()
      .eq('url', url);

    if (deleteError) {
      logger.error('[StorageDB] Failed to delete blob file record:', deleteError);
      throw new Error(`Failed to delete blob file: ${deleteError.message}`);
    }

    // 使用量を減算（ユーザーとグローバル）
    const { error: rpcError } = await supabaseAdmin.rpc('update_storage_usage', {
      p_user_prefix: data.user_prefix,
      p_size_delta: -data.file_size,
      p_count_delta: -1,
    });

    if (rpcError) {
      logger.error('[StorageDB] Failed to update storage usage after delete:', rpcError);
      // 使用量更新が失敗してもファイル削除は成功したのでログのみ
    }

    logger.info(`[StorageDB] Removed blob file: ${url}, size: ${data.file_size}`);

    return {
      userPrefix: data.user_prefix,
      fileSize: data.file_size,
      storageType: data.storage_type as 'r2' | 'vercel',
    };
  } catch (error) {
    logger.error('[StorageDB] Error removing blob file:', error);
    throw error;
  }
}

/**
 * 配信者のストレージボーナス合計を取得（バイト単位）
 * streamer_storage_bonus テーブルから該当streamerの全ボーナスを合計
 *
 * @param twitchUserId - Twitch ユーザーID
 * @returns ボーナス合計（バイト単位）、ボーナスなしまたはエラー時は0
 */
export async function getStorageBonusBytes(twitchUserId: string): Promise<number> {
  try {
    const supabaseAdmin = getSupabaseAdmin();

    // streamersテーブル経由でstreamer_storage_bonusをリレーションで取得
    const { data, error } = await supabaseAdmin
      .from('streamers')
      .select('streamer_storage_bonus(amount_mb)')
      .eq('twitch_user_id', twitchUserId)
      .maybeSingle();

    if (error || !data) {
      return 0;
    }

    const bonuses = data.streamer_storage_bonus as Array<{ amount_mb: number }> | null;
    if (!bonuses || bonuses.length === 0) {
      return 0;
    }

    // MB → bytes に変換して合計
    const totalMb = bonuses.reduce((sum, b) => sum + b.amount_mb, 0);
    return totalMb * 1024 * 1024;
  } catch (error) {
    // ボーナス取得失敗時はゼロとする（ユーザーに不利にしない）
    // logger.error が自動的に Supabase に記録するため reportError は不要
    logger.error('[StorageDB] Failed to get storage bonus:', error);
    return 0;
  }
}

/**
 * TwitchユーザーIDで指定されたストレージボーナスが既に適用済みかチェック
 * 非配信者でも将来の恩恵を受けられるようにするため、twitch_user_id で検索
 *
 * @param twitchUserId - Twitch ユーザーID
 * @param type - ボーナスの種類
 * @param memo - 管理用メモ
 * @returns 適用済みの場合true
 */
export async function hasStorageBonusByTwitchUserId(
  twitchUserId: string,
  type: string,
  memo: string
): Promise<boolean> {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    // streamers テーブル経由で streamer_storage_bonus を検索
    const { data } = await supabaseAdmin
      .from('streamers')
      .select('streamer_storage_bonus!inner(id)')
      .eq('twitch_user_id', twitchUserId)
      .eq('streamer_storage_bonus.type', type)
      .eq('streamer_storage_bonus.memo', memo)
      .maybeSingle();
    return !!data;
  } catch (error) {
    logger.error('[StorageDB] Failed to check storage bonus by twitch_user_id:', error);
    return false;
  }
}

/**
 * 投票キャンペーンボタンの表示判定
 * キャンペーン期間内 かつ 未適用の場合にtrueを返す
 * cache()でリクエスト単位のキャッシュを適用し、同一リクエスト内での重複DB呼び出しを防止
 *
 * @param twitchUserId - Twitch ユーザーID
 * @returns キャンペーンボタンを表示すべき場合true
 */
export const shouldShowVoteCampaign = cache(async function shouldShowVoteCampaign(twitchUserId: string): Promise<boolean> {
  const now = new Date();
  if (now < VOTE_CAMPAIGN_CONFIG.START_DATE || now > VOTE_CAMPAIGN_CONFIG.END_DATE) {
    return false;
  }
  return !(await hasStorageBonusByTwitchUserId(
    twitchUserId,
    VOTE_CAMPAIGN_CONFIG.TYPE,
    VOTE_CAMPAIGN_CONFIG.MEMO
  ));
})

/**
 * 全ユーザーのストレージ使用量サマリーを取得（管理用）
 *
 * @returns 全ユーザーの使用量一覧
 */
export async function getAllStorageUsage(): Promise<Array<{
  userPrefix: string;
  bytesUsed: number;
  blobCount: number;
}>> {
  try {
    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .from('storage_usage')
      .select('user_prefix, bytes_used, blob_count')
      .order('bytes_used', { ascending: false });

    if (error) {
      logger.error('[StorageDB] Failed to get all storage usage:', error);
      throw new Error(`Failed to get all storage usage: ${error.message}`);
    }

    return (data || []).map(row => ({
      userPrefix: row.user_prefix,
      bytesUsed: row.bytes_used,
      blobCount: row.blob_count,
    }));
  } catch (error) {
    logger.error('[StorageDB] Error getting all storage usage:', error);
    throw error;
  }
}
