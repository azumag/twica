import { list } from '@vercel/blob';
import { UPLOAD_CONFIG } from './constants';
import { logger } from './logger';

export interface StorageUsage {
  userUsage: number;
  globalUsage: number;
  userLimitReached: boolean;
  globalLimitReached: boolean;
  userLimitBytes: number;
  globalLimitBytes: number;
}

// Get storage usage for a specific user and global total
// 特定ユーザーと全体のストレージ使用量を取得
export async function getStorageUsage(userPrefix?: string): Promise<StorageUsage> {
  try {
    let globalUsage = 0;
    let userUsage = 0;
    let cursor: string | undefined;

    // Iterate through all blobs to calculate usage
    // 全てのBlobを反復して使用量を計算
    let blobCount = 0;
    let userBlobCount = 0;
    const samplePathnames: string[] = [];
    do {
      const response = await list({ cursor, limit: 1000 });

      for (const blob of response.blobs) {
        blobCount++;
        globalUsage += blob.size;
        // Collect first 3 pathnames for debugging
        // デバッグ用に最初の3件のpathnameを収集
        if (samplePathnames.length < 3) {
          samplePathnames.push(blob.pathname);
        }

        // Check if blob belongs to the user (filename contains user's hash prefix)
        // Blobがユーザーのものかチェック（ファイル名にユーザーのハッシュプレフィックスが含まれるか）
        if (userPrefix) {
          // Extract filename from pathname (pathname may include full path or random suffix)
          // pathnameからファイル名を抽出（pathnameにはフルパスやランダムサフィックスが含まれる場合がある）
          const filename = blob.pathname.split('/').pop() || blob.pathname;
          // Check if filename starts with userPrefix or contains it after path separators
          // Vercel Blob may add random suffixes like: userPrefix_hash-randomsuffix.ext
          // ファイル名がuserPrefixで始まるか、パス区切り後に含まれるかチェック
          // Vercel Blobはランダムサフィックスを追加する場合がある: userPrefix_hash-randomsuffix.ext
          if (filename.startsWith(userPrefix) || filename.includes(`/${userPrefix}`)) {
            userUsage += blob.size;
            userBlobCount++;
          }
        }
      }

      cursor = response.cursor;
    } while (cursor);

    // Debug logging to help identify storage calculation issues
    // ストレージ計算の問題を特定するためのデバッグログ
    logger.info(`[StorageUsage] Total blobs: ${blobCount}, User blobs: ${userBlobCount}, User prefix: ${userPrefix}, Global: ${globalUsage}, User: ${userUsage}, Sample pathnames: ${JSON.stringify(samplePathnames)}`);

    return {
      userUsage,
      globalUsage,
      userLimitReached: userUsage >= UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitReached: globalUsage >= UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
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

// Format bytes to human readable string
// バイトを人間が読める形式にフォーマット
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
