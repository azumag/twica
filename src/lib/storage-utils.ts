/**
 * Storage URL Utility Functions
 * ストレージURLの判定ヘルパー関数
 *
 * R2とVercel Blobの両方をサポートするための共通ユーティリティ
 */

import { getR2PublicUrl } from './r2-client';

/**
 * URLがR2のURLかどうかを判定
 * @param url - チェックするURL
 * @returns R2のURLの場合はtrue
 */
export function isR2Url(url: string): boolean {
  if (!url) return false;

  // 環境変数で設定されたR2パブリックURLをチェック
  try {
    const r2PublicUrl = getR2PublicUrl();
    if (url.startsWith(r2PublicUrl)) {
      return true;
    }
  } catch {
    // R2環境変数が設定されていない場合は無視
  }

  // 一般的なR2のURLパターンをチェック
  // .r2.dev ドメイン または r2.cloudflarestorage.com
  return url.includes('.r2.dev') || url.includes('r2.cloudflarestorage.com');
}

/**
 * URLがVercel BlobのURLかどうかを判定
 * @param url - チェックするURL
 * @returns Vercel BlobのURLの場合はtrue
 */
export function isVercelBlobUrl(url: string): boolean {
  if (!url) return false;
  return url.includes('blob.vercel-storage.com') ||
         url.includes('public.blob.vercel-storage.com');
}

/**
 * URLがストレージURL（R2またはVercel Blob）かどうかを判定
 * @param url - チェックするURL
 * @returns ストレージURLの場合はtrue
 */
export function isStorageUrl(url: string): boolean {
  return isR2Url(url) || isVercelBlobUrl(url);
}

/**
 * ストレージの種類を判定
 * @param url - チェックするURL
 * @returns 'r2' | 'vercel' | null
 */
export function getStorageType(url: string): 'r2' | 'vercel' | null {
  if (isR2Url(url)) return 'r2';
  if (isVercelBlobUrl(url)) return 'vercel';
  return null;
}

/**
 * R2 URLからキー（ファイル名）を抽出
 * @param url - R2のURL
 * @returns ファイル名（キー）、または抽出できない場合はnull
 */
export function getR2KeyFromUrl(url: string): string | null {
  if (!url) return null;

  try {
    const urlObj = new URL(url);
    // パスから先頭の '/' を除去してキーを取得
    const key = urlObj.pathname.slice(1);
    return key || null;
  } catch {
    // URLのパースに失敗した場合
    return null;
  }
}

/**
 * Vercel Blob URLからパス名を抽出
 * @param url - Vercel BlobのURL
 * @returns パス名、または抽出できない場合はnull
 */
export function getVercelBlobPathFromUrl(url: string): string | null {
  if (!url) return null;

  try {
    const urlObj = new URL(url);
    // パスから先頭の '/' を除去
    const path = urlObj.pathname.slice(1);
    return path || null;
  } catch {
    return null;
  }
}

/**
 * URLからユーザープレフィックス（8文字のハッシュ）を抽出
 * ファイル名のフォーマット: {userPrefix}_{uniqueSuffix}.{ext}
 * @param url - ストレージURL
 * @returns ユーザープレフィックス（8文字）、または抽出できない場合はnull
 */
export function extractUserPrefixFromUrl(url: string): string | null {
  if (!url) return null;

  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    // パスの最後の部分（ファイル名）を取得
    const fileName = pathname.split('/').pop();
    if (!fileName) return null;

    // ファイル名から拡張子を除去
    const nameWithoutExt = fileName.split('.')[0];
    if (!nameWithoutExt) return null;

    // ユーザープレフィックスを抽出（最初の8文字）
    // フォーマット: {userPrefix}_{uniqueSuffix}
    const prefix = nameWithoutExt.split('_')[0];
    if (prefix && prefix.length === 8) {
      return prefix;
    }

    return null;
  } catch {
    return null;
  }
}
