import { list } from '@vercel/blob';
import { UPLOAD_CONFIG } from './constants';

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
    do {
      const response = await list({ cursor, limit: 1000 });

      for (const blob of response.blobs) {
        globalUsage += blob.size;

        // Check if blob belongs to the user (filename starts with user's hash prefix)
        // Blobがユーザーのものかチェック（ファイル名がユーザーのハッシュプレフィックスで始まるか）
        if (userPrefix) {
          // Extract filename from pathname (pathname may include full path)
          // pathnameからファイル名を抽出（pathnameにはフルパスが含まれる場合がある）
          const filename = blob.pathname.split('/').pop() || blob.pathname;
          if (filename.startsWith(userPrefix)) {
            userUsage += blob.size;
          }
        }
      }

      cursor = response.cursor;
    } while (cursor);

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
    console.error('Failed to get storage usage:', error);
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
