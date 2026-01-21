/**
 * Storage Usage Module
 * ストレージ使用量管理モジュール
 *
 * 変更履歴:
 * - 以前: Vercel Blob の list() を使用して使用量を計算
 * - 現在: DB経由で使用量を取得（list() 操作数を節約）
 *
 * Vercel Blobの操作数制限（2,000/月）を回避するため、
 * 使用量情報をDBで管理する方式に変更
 */

import { UPLOAD_CONFIG } from './constants';
import { logger } from './logger';
import { getStorageUsageFromDB } from './storage-db';

export interface StorageUsage {
  userUsage: number;
  globalUsage: number;
  userLimitReached: boolean;
  globalLimitReached: boolean;
  userLimitBytes: number;
  globalLimitBytes: number;
}

/**
 * Get storage usage for a specific user and global total
 * 特定ユーザーと全体のストレージ使用量を取得
 *
 * DB経由で使用量を取得する。Vercel Blob の list() は使用しない。
 * これにより操作数制限（2,000/月）を大幅に節約できる。
 *
 * @param userPrefix - ユーザー識別用のプレフィックス（8文字のハッシュ）
 * @returns ストレージ使用量情報
 */
export async function getStorageUsage(userPrefix?: string): Promise<StorageUsage> {
  try {
    // userPrefixが指定されていない場合は空文字を使用
    // この場合、ユーザー個別の使用量は0として扱う
    const prefix = userPrefix || '';

    const dbUsage = await getStorageUsageFromDB(prefix);

    logger.info(`[StorageUsage] User: ${prefix}, User Usage: ${dbUsage.userUsage}, Global Usage: ${dbUsage.globalUsage}`);

    return {
      userUsage: dbUsage.userUsage,
      globalUsage: dbUsage.globalUsage,
      userLimitReached: dbUsage.userLimitReached,
      globalLimitReached: dbUsage.globalLimitReached,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    };
  } catch (error) {
    // If we can't check usage, assume limits are not reached to not block uploads
    // 使用量を確認できない場合は、アップロードをブロックしないように制限に達していないと仮定
    logger.error('[StorageUsage] Failed to get storage usage:', error);
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
 * Format bytes to human readable string
 * バイトを人間が読める形式にフォーマット
 *
 * @param bytes - バイト数
 * @returns フォーマットされた文字列（例: "1.5 MB"）
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
