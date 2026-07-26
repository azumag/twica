/**
 * Ownership-checked storage image deletion
 * 所有権を検証したうえでストレージ画像を削除する共通処理 (#830)
 *
 * 画像の削除経路は3箇所ある。
 *   1. POST /api/upload/delete            （明示的な削除）
 *   2. PUT  /api/cards/[id]               （画像差し替え時の旧画像クリーンアップ）
 *   3. DELETE /api/cards/[id]             （カード削除時のクリーンアップ）
 *
 * これらは同じ「DB記録の削除 → R2オブジェクトの削除」を行うが、#830 以前は
 * 3箇所ともコピーで、かつ所有権検証が一切なかった。検証を各所へ書き足すと
 * 再び抜ける（新しい削除経路が追加されたときに忘れる）ため、削除の入口を
 * この関数に一本化し、所有権検証を通らない限り削除処理へ進めない構造にする。
 */

import 'server-only';

import { logger } from './logger.server';
import { deleteFromR2 } from './r2-client';
import { removeBlobFile } from './storage-db';
import {
  getR2KeyFromUrl,
  isOwnedStorageUrl,
  isR2Url,
  isStorageUrl,
  isVercelBlobUrl,
} from './storage-utils';

/**
 * 削除処理の結果
 * - `deleted`: 所有権検証を通過し削除処理を実行した
 *   （Vercel Blob URL の場合は R2 移行済みのため実体削除はせずDB記録のみ削除する）
 * - `not-storage`: 自前ストレージのURLではないため何もしていない（外部CDN等）
 * - `forbidden`: 他人の所有物のため何も削除していない
 */
export type StorageImageDeleteOutcome = 'deleted' | 'not-storage' | 'forbidden';

/**
 * 所有権を検証したうえでストレージ画像を削除する
 *
 * DB記録の削除は best-effort（失敗しても警告ログのみ。使用量は初期化スクリプトで
 * 再計算できる）。ストレージ削除の失敗は呼び出し元が扱えるよう throw する。
 *
 * @param url - 削除対象のストレージURL
 * @param twitchUserId - 削除を要求しているTwitchユーザーID
 * @param context - ログ用のコンテキスト名
 * @returns 削除処理の結果
 */
export async function deleteOwnedStorageImage(
  url: string,
  twitchUserId: string,
  context: string
): Promise<StorageImageDeleteOutcome> {
  if (!isStorageUrl(url)) {
    return 'not-storage';
  }

  // 検証したキーと削除するキーが同一であることを構造的に保証するため、
  // キーはここで1度だけ取り出して以降も同じ値を使う。
  const key = getR2KeyFromUrl(url);

  if (!key || !(await isOwnedStorageUrl(url, twitchUserId))) {
    // 「他人のオブジェクトへの削除要求」と「所有者を判定できないキー」を同じ
    // fail-closed で扱うため、ログ文言も断定しない。本番/preview の
    // cards.image_url は実測で 100% が `{prefix}_` 形式（#830 の調査）なので、
    // 実際にここへ来るのは不正な削除要求だけの想定。
    logger.warn(`[${context}] Storage ownership mismatch, delete skipped: ${url} (requested by user ${twitchUserId})`);
    return 'forbidden';
  }

  // DBからファイル情報を削除（使用量も自動的に減算される）
  // DB操作に失敗してもストレージからの削除は続行する
  try {
    await removeBlobFile(url);
  } catch (dbError) {
    logger.warn(`[${context}] Failed to remove blob file from DB: ${url}`, dbError);
  }

  if (isR2Url(url)) {
    await deleteFromR2(key);
    logger.info(`[${context}] Deleted R2 file: ${key}`);
  } else if (isVercelBlobUrl(url)) {
    // Vercel Blob URLs are no longer actively deleted
    // Migration to R2 should have moved these files
    // Vercel Blob URLは削除しない（R2移行済みのはず）
    logger.warn(`[${context}] Vercel Blob URL found but deletion skipped: ${url}`);
  }

  return 'deleted';
}
