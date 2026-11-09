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

import 'server-only';

import { UPLOAD_CONFIG } from './constants';
import { logger } from './logger.server';
import {
  getStorageUsageFromDB,
  getStorageBonusBytes,
  reserveStorageUsage,
} from './storage-db';
import { getPlanStorageBytes } from './plan';

export interface StorageUsage {
  userUsage: number;
  globalUsage: number;
  userLimitReached: boolean;
  globalLimitReached: boolean;
  userLimitBytes: number;
  globalLimitBytes: number;
  // プランダウングレード時に容量超過している場合true
  // true when user exceeds storage limit after plan downgrade
  planOverLimit: boolean;
}

/**
 * Get storage usage for a specific user and global total
 * 特定ユーザーと全体のストレージ使用量を取得
 *
 * DB経由で使用量を取得する。Vercel Blob の list() は使用しない。
 * これにより操作数制限（2,000/月）を大幅に節約できる。
 *
 * @param userPrefix - ユーザー識別用のプレフィックス（8文字のハッシュ）
 * @param twitchUserId - Twitch ユーザーID（指定時はストレージボーナスを加味）
 * @returns ストレージ使用量情報
 */
export async function getStorageUsage(userPrefix?: string, twitchUserId?: string): Promise<StorageUsage> {
  try {
    // userPrefixが指定されていない場合は空文字を使用
    // この場合、ユーザー個別の使用量は0として扱う
    const prefix = userPrefix || '';

    // DB使用量、ストレージボーナス、プランボーナスを並列取得してレイテンシを削減
    const [dbUsage, bonusBytes, planBytes] = await Promise.all([
      getStorageUsageFromDB(prefix),
      twitchUserId ? getStorageBonusBytes(twitchUserId) : Promise.resolve(0),
      twitchUserId ? getPlanStorageBytes(twitchUserId) : Promise.resolve(0),
    ]);
    const effectiveLimit = UPLOAD_CONFIG.USER_STORAGE_LIMIT + bonusBytes + planBytes;

    logger.info(`[StorageUsage] User: ${prefix}, User Usage: ${dbUsage.userUsage}, Global Usage: ${dbUsage.globalUsage}, Bonus: ${bonusBytes}, Plan: ${planBytes}`);

    return {
      userUsage: dbUsage.userUsage,
      globalUsage: dbUsage.globalUsage,
      userLimitReached: dbUsage.userUsage >= effectiveLimit,
      globalLimitReached: dbUsage.globalLimitReached,
      userLimitBytes: effectiveLimit,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
      // プランダウングレード後にデフォルト制限を超過している場合にtrue
      planOverLimit: dbUsage.userUsage > effectiveLimit,
    };
  } catch (error) {
    // 容量が取得不能な場合は無制限保存へ進めない (#1896)
    logger.error('[StorageUsage] Failed to get storage usage, blocking upload:', error);
    return {
      userUsage: 0,
      globalUsage: 0,
      userLimitReached: true,
      globalLimitReached: true,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
      planOverLimit: false,
    };
  }
}

export type StorageCapacityReservation =
  | { ok: true; reservationId: string; degraded: false }
  | { ok: true; reservationId: null; degraded: true }
  | { ok: false; reason: 'user_limit' | 'global_limit' };

/**
 * 実効上限（ボーナス・プラン込み）を取得し、追加バイト数を原子的に予約する (#1907)。
 *
 * 画像・音声の両アップロード経路は、以前は getStorageUsage を複数回呼んで
 * 「現在使用量 + 追加バイト数」をアプリ側で比較していた。その方式は
 * 取得と保存の間に並列要求が入ると上限を突破でき、画像ルートでは同じ
 * リクエストで getStorageUsage を 2 回呼んでいた（#1907 の任意指摘）。
 *
 * ここでは上限判定に必要な情報を 1 回だけ取得し、最終判定は DB の
 * reserve_storage_usage に任せる。DB は「確定済み使用量 + 有効な予約」で
 * 判定するため、同一ユーザー・並列ユーザーのどちらでも上限を超えない。
 *
 * @param userPrefix - 8 文字のユーザープレフィックス
 * @param twitchUserId - ボーナス・プラン加算の対象ユーザー
 * @param fileSize - 追加バイト数
 * @param prefetchedUsage - 呼び出し元が既に取得済みの使用量（同一リクエストで
 *   getStorageUsage を重複実行しないための任意引数）。省略時はここで取得する。
 *   予約 RPC 自体は常に DB の最新値で判定するため、この値は上限計算にだけ使う。
 * @returns 予約 ID、または上限到達理由
 */
export async function reserveStorageCapacity(
  userPrefix: string,
  twitchUserId: string,
  fileSize: number,
  prefetchedUsage?: StorageUsage,
): Promise<StorageCapacityReservation> {
  const usage = prefetchedUsage ?? await getStorageUsage(userPrefix, twitchUserId);

  // getStorageUsage は取得失敗時に「usage=0 + 両フラグ true」を返す（#1896）。
  // フラグをバイト比較より先に見ないと、無制限保存へ進んでしまう。
  if (usage.globalLimitReached) {
    return { ok: false, reason: 'global_limit' };
  }
  if (usage.userLimitReached) {
    return { ok: false, reason: 'user_limit' };
  }

  const reservation = await reserveStorageUsage(
    userPrefix,
    fileSize,
    usage.userLimitBytes,
    usage.globalLimitBytes,
  );

  if (reservation.degraded) {
    // reserve RPC 未適用のデプロイ窓。旧来の非原子的な経路でアップロードを
    // 継続する（呼び出し元は recordBlobFile の legacy 経路を使う）。
    // 予約 RPC が無いので、少なくとも旧実装と同じ「現在使用量 + 追加バイト数」の
    // 事前判定はここで行い、上限超過の保存を許さない。
    if (usage.globalUsage + fileSize > usage.globalLimitBytes) {
      return { ok: false, reason: 'global_limit' };
    }
    if (usage.userUsage + fileSize > usage.userLimitBytes) {
      return { ok: false, reason: 'user_limit' };
    }
    return { ok: true, reservationId: null, degraded: true };
  }

  if (reservation.outcome === 'reserved') {
    if (!reservation.reservationId) {
      // DB 関数の契約違反。予約 ID が無いまま保存を進めると確定できない。
      throw new Error('reserve_storage_usage returned reserved without a reservation ID');
    }
    return {
      ok: true,
      reservationId: reservation.reservationId,
      degraded: false,
    };
  }

  return {
    ok: false,
    reason: reservation.outcome === 'global_limit' ? 'global_limit' : 'user_limit',
  };
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
