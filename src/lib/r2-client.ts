/**
 * R2 Client - Cloudflare R2 Native Bindings with S3 SDK Fallback
 * Cloudflare R2ネイティブバインディング（S3 SDKフォールバック付き）
 *
 * In Cloudflare Workers environment, uses native R2 bindings (zero SDK overhead).
 * In local development (`next dev`), falls back to @aws-sdk/client-s3 via
 * environment variables (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).
 *
 * Cloudflare Workers環境ではネイティブR2バインディングを使用（SDKオーバーヘッドゼロ）。
 * ローカル開発（`next dev`）では環境変数経由で@aws-sdk/client-s3にフォールバック。
 *
 * See: https://github.com/azumag/twica/issues/235
 */

import { logger } from './logger';

/**
 * Minimal R2Bucket interface matching Cloudflare Workers R2 API.
 * Avoids requiring @cloudflare/workers-types in tsconfig.
 * Cloudflare Workers R2 APIの最小限のインターフェース定義。
 * tsconfigに@cloudflare/workers-typesを要求しないようにする。
 */
interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
}

/**
 * Get a native R2 bucket binding from Cloudflare Workers environment.
 * Returns null when not running in Workers (e.g. local `next dev`).
 *
 * Cloudflare Workers環境からネイティブR2バケットバインディングを取得。
 * Workers以外の環境（例: ローカル`next dev`）ではnullを返す。
 */
async function getR2Binding(bindingName: 'R2_IMAGES' | 'R2_SOUNDS'): Promise<R2BucketLike | null> {
  try {
    // Dynamic import to avoid bundling @opennextjs/cloudflare in local dev
    // ローカル開発時に@opennextjs/cloudflareをバンドルしないよう動的インポート
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const ctx = await getCloudflareContext({ async: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binding = (ctx.env as any)[bindingName] as R2BucketLike | undefined;
    return binding ?? null;
  } catch {
    // Not running in Cloudflare Workers environment
    // Cloudflare Workers環境では実行されていない
    return null;
  }
}

/**
 * R2パブリックURLを取得（画像用）
 */
export function getR2PublicUrl(): string {
  const publicUrl = process.env.R2_PUBLIC_URL;
  if (!publicUrl) {
    throw new Error('Missing R2_PUBLIC_URL environment variable');
  }
  // 末尾のスラッシュを除去して統一
  return publicUrl.replace(/\/$/, '');
}

/**
 * 効果音バケットのパブリックURLを取得
 */
export function getR2SoundPublicUrl(): string {
  const publicUrl = process.env.R2_SOUND_PUBLIC_URL;
  if (!publicUrl) {
    throw new Error('Missing R2_SOUND_PUBLIC_URL environment variable');
  }
  // 末尾のスラッシュを除去して統一
  return publicUrl.replace(/\/$/, '');
}

// ============================================================================
// S3 SDK Fallback for local development (`next dev`)
// ローカル開発（`next dev`）用のS3 SDKフォールバック
// ============================================================================

/**
 * Lazily import S3 SDK only for local development.
 * Wrapped in a function to avoid loading SDK in Workers environment.
 * ローカル開発時のみS3 SDKを遅延インポート。
 * Workers環境でSDKを読み込まないように関数でラップ。
 */
async function s3Upload(bucket: string, key: string, body: Buffer | Uint8Array, contentType: string, clientType: 'images' | 'sounds'): Promise<void> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = clientType === 'sounds'
    ? process.env.R2_SOUND_ACCESS_KEY_ID
    : process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = clientType === 'sounds'
    ? process.env.R2_SOUND_SECRET_ACCESS_KEY
    : process.env.R2_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(`Missing R2 environment variables for ${clientType} (R2_ENDPOINT, R2_*_ACCESS_KEY_ID, R2_*_SECRET_ACCESS_KEY)`);
  }

  const client = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } });
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
}

async function s3Delete(bucket: string, key: string, clientType: 'images' | 'sounds'): Promise<void> {
  const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = clientType === 'sounds'
    ? process.env.R2_SOUND_ACCESS_KEY_ID
    : process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = clientType === 'sounds'
    ? process.env.R2_SOUND_SECRET_ACCESS_KEY
    : process.env.R2_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(`Missing R2 environment variables for ${clientType} (R2_ENDPOINT, R2_*_ACCESS_KEY_ID, R2_*_SECRET_ACCESS_KEY)`);
  }

  const client = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } });
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// ============================================================================
// Public API - Same interface as before, but uses native bindings when available
// パブリックAPI - 同じインターフェースだが、利用可能な場合はネイティブバインディングを使用
// ============================================================================

/**
 * R2にファイルをアップロード（画像用）
 * Workers環境ではネイティブバインディング、ローカルではS3 SDKを使用
 * @param fileName - ファイル名（キー）
 * @param buffer - ファイルデータ
 * @param contentType - MIMEタイプ
 * @returns アップロードされたファイルの公開URL
 */
export async function uploadToR2(
  fileName: string,
  buffer: Buffer | Uint8Array,
  contentType: string
): Promise<string> {
  const publicUrl = getR2PublicUrl();

  try {
    const binding = await getR2Binding('R2_IMAGES');
    if (binding) {
      // Native R2 binding (Cloudflare Workers) - no SDK overhead
      // ネイティブR2バインディング（Cloudflare Workers）- SDKオーバーヘッドなし
      await binding.put(fileName, buffer, { httpMetadata: { contentType } });
    } else {
      // S3 SDK fallback for local development
      // ローカル開発用S3 SDKフォールバック
      const bucket = process.env.R2_BUCKET_NAME;
      if (!bucket) throw new Error('Missing R2_BUCKET_NAME environment variable');
      await s3Upload(bucket, fileName, buffer, contentType, 'images');
    }

    const url = `${publicUrl}/${fileName}`;
    logger.info(`[R2] Uploaded file: ${fileName}, size: ${buffer.length} bytes`);
    return url;
  } catch (error) {
    logger.error('[R2] Failed to upload file:', error);
    throw error;
  }
}

/**
 * R2効果音バケットにファイルをアップロード
 * Workers環境ではネイティブバインディング、ローカルではS3 SDKを使用
 * @param fileName - ファイル名（キー）
 * @param buffer - ファイルデータ
 * @param contentType - MIMEタイプ（audio/mpeg, audio/wav等）
 * @returns アップロードされたファイルの公開URL
 */
export async function uploadSoundToR2(
  fileName: string,
  buffer: Buffer | Uint8Array,
  contentType: string
): Promise<string> {
  const publicUrl = getR2SoundPublicUrl();

  try {
    const binding = await getR2Binding('R2_SOUNDS');
    if (binding) {
      // Native R2 binding (Cloudflare Workers)
      await binding.put(fileName, buffer, { httpMetadata: { contentType } });
    } else {
      // S3 SDK fallback for local development
      const bucket = process.env.R2_SOUND_BUCKET_NAME;
      if (!bucket) throw new Error('Missing R2_SOUND_BUCKET_NAME environment variable');
      await s3Upload(bucket, fileName, buffer, contentType, 'sounds');
    }

    const url = `${publicUrl}/${fileName}`;
    logger.info(`[R2 Sound] Uploaded sound file: ${fileName}, size: ${buffer.length} bytes`);
    return url;
  } catch (error) {
    logger.error('[R2 Sound] Failed to upload sound file:', error);
    throw error;
  }
}

/**
 * R2からファイルを削除（画像用）
 * Workers環境ではネイティブバインディング、ローカルではS3 SDKを使用
 * @param fileName - ファイル名（キー）
 */
export async function deleteFromR2(fileName: string): Promise<void> {
  try {
    const binding = await getR2Binding('R2_IMAGES');
    if (binding) {
      // Native R2 binding (Cloudflare Workers)
      await binding.delete(fileName);
    } else {
      // S3 SDK fallback for local development
      const bucket = process.env.R2_BUCKET_NAME;
      if (!bucket) throw new Error('Missing R2_BUCKET_NAME environment variable');
      await s3Delete(bucket, fileName, 'images');
    }
    logger.info(`[R2] Deleted file: ${fileName}`);
  } catch (error) {
    logger.error('[R2] Failed to delete file:', error);
    throw error;
  }
}

/**
 * R2効果音バケットからファイルを削除
 * Workers環境ではネイティブバインディング、ローカルではS3 SDKを使用
 * @param fileName - ファイル名（キー）
 */
export async function deleteSoundFromR2(fileName: string): Promise<void> {
  try {
    const binding = await getR2Binding('R2_SOUNDS');
    if (binding) {
      // Native R2 binding (Cloudflare Workers)
      await binding.delete(fileName);
    } else {
      // S3 SDK fallback for local development
      const bucket = process.env.R2_SOUND_BUCKET_NAME;
      if (!bucket) throw new Error('Missing R2_SOUND_BUCKET_NAME environment variable');
      await s3Delete(bucket, fileName, 'sounds');
    }
    logger.info(`[R2 Sound] Deleted sound file: ${fileName}`);
  } catch (error) {
    logger.error('[R2 Sound] Failed to delete sound file:', error);
    throw error;
  }
}

/**
 * リトライ付きR2アップロード（画像用）
 * R2ネイティブバインディングはCloudflare内部通信のためエラー率が低いが、
 * S3 SDKフォールバック時のネットワークエラーに備えてリトライを維持
 * @param fileName - ファイル名（キー）
 * @param buffer - ファイルデータ
 * @param contentType - MIMEタイプ
 * @param maxRetries - 最大リトライ回数（デフォルト: 3）
 * @returns アップロードされたファイルの公開URL、またはエラー
 */
export async function uploadToR2WithRetry(
  fileName: string,
  buffer: Buffer | Uint8Array,
  contentType: string,
  maxRetries: number = 3
): Promise<{ url: string } | { error: string }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const url = await uploadToR2(fileName, buffer, contentType);
      return { url };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 一時的なエラーかどうかを判定
      // "Unspecified error" はR2ネイティブバインディングの一時障害 (Issue #349/#348)
      const transientErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'service unavailable', '503', 'NetworkingError', 'Unspecified error'];
      const isTransient = transientErrors.some(err =>
        errorMessage.toLowerCase().includes(err.toLowerCase())
      );

      if (!isTransient || attempt === maxRetries) {
        return { error: errorMessage };
      }

      // 指数バックオフでリトライ
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn(`[R2] Upload failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, errorMessage);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { error: 'Max retries exceeded' };
}

/**
 * リトライ付きR2効果音アップロード
 * R2ネイティブバインディングはCloudflare内部通信のためエラー率が低いが、
 * S3 SDKフォールバック時のネットワークエラーに備えてリトライを維持
 * @param fileName - ファイル名（キー）
 * @param buffer - ファイルデータ
 * @param contentType - MIMEタイプ
 * @param maxRetries - 最大リトライ回数（デフォルト: 3）
 * @returns アップロードされたファイルの公開URL、またはエラー
 */
export async function uploadSoundToR2WithRetry(
  fileName: string,
  buffer: Buffer | Uint8Array,
  contentType: string,
  maxRetries: number = 3
): Promise<{ url: string } | { error: string }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const url = await uploadSoundToR2(fileName, buffer, contentType);
      return { url };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 一時的なエラーかどうかを判定
      // "Unspecified error" はR2ネイティブバインディングの一時障害 (Issue #349/#348)
      const transientErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'service unavailable', '503', 'NetworkingError', 'Unspecified error'];
      const isTransient = transientErrors.some(err =>
        errorMessage.toLowerCase().includes(err.toLowerCase())
      );

      if (!isTransient || attempt === maxRetries) {
        return { error: errorMessage };
      }

      // 指数バックオフでリトライ
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn(`[R2 Sound] Upload failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, errorMessage);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return { error: 'Max retries exceeded' };
}
