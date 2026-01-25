import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { logger } from './logger';

/**
 * R2 Client Configuration
 * Cloudflare R2はS3互換APIを提供するため、AWS SDKを使用
 *
 * 画像用環境変数:
 * - R2_ENDPOINT: R2エンドポイントURL (例: https://<account_id>.r2.cloudflarestorage.com)
 * - R2_ACCESS_KEY_ID: R2アクセスキーID
 * - R2_SECRET_ACCESS_KEY: R2シークレットアクセスキー
 * - R2_BUCKET_NAME: R2バケット名
 * - R2_PUBLIC_URL: R2パブリックURL (例: https://pub-xxx.r2.dev または カスタムドメイン)
 *
 * 効果音用環境変数（すべて必須）:
 * - R2_SOUND_ACCESS_KEY_ID: 効果音バケット用アクセスキーID
 * - R2_SOUND_SECRET_ACCESS_KEY: 効果音バケット用シークレットアクセスキー
 * - R2_SOUND_BUCKET_NAME: 効果音バケット名
 * - R2_SOUND_PUBLIC_URL: 効果音バケットのパブリックURL
 */

// R2クライアントをシングルトンパターンで管理
// リクエストごとにクライアントを作成するとコストがかかるため
let r2ClientInstance: S3Client | null = null;
// 効果音バケット用の別クライアント（別アカウント/別認証情報に対応）
let r2SoundClientInstance: S3Client | null = null;

/**
 * R2クライアントを取得（シングルトン）
 * 初回呼び出し時にクライアントを初期化し、以降は同じインスタンスを返す
 */
export function getR2Client(): S3Client {
  if (r2ClientInstance) {
    return r2ClientInstance;
  }

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2 environment variables: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }

  r2ClientInstance = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return r2ClientInstance;
}

/**
 * R2バケット名を取得（画像用）
 */
export function getR2Bucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) {
    throw new Error('Missing R2_BUCKET_NAME environment variable');
  }
  return bucket;
}

/**
 * 効果音バケット用R2クライアントを取得（シングルトン）
 * エンドポイントは共通、認証情報のみ別
 * @throws 必要な環境変数が未設定の場合にエラー
 */
export function getR2SoundClient(): S3Client {
  if (r2SoundClientInstance) {
    return r2SoundClientInstance;
  }

  // エンドポイントは画像バケットと共通
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_SOUND_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SOUND_SECRET_ACCESS_KEY;

  if (!endpoint) {
    throw new Error('Missing R2_ENDPOINT environment variable');
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2 sound environment variables: R2_SOUND_ACCESS_KEY_ID, R2_SOUND_SECRET_ACCESS_KEY');
  }

  r2SoundClientInstance = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return r2SoundClientInstance;
}

/**
 * R2効果音バケット名を取得
 * 画像バケットとは別に管理するため、専用の環境変数が必須
 * @throws R2_SOUND_BUCKET_NAMEが未設定の場合にエラー
 */
export function getR2SoundBucket(): string {
  const soundBucket = process.env.R2_SOUND_BUCKET_NAME;
  if (!soundBucket) {
    throw new Error('Missing R2_SOUND_BUCKET_NAME environment variable');
  }
  return soundBucket;
}

/**
 * 効果音バケットのパブリックURLを取得
 * @throws R2_SOUND_PUBLIC_URLが未設定の場合にエラー
 */
export function getR2SoundPublicUrl(): string {
  const publicUrl = process.env.R2_SOUND_PUBLIC_URL;
  if (!publicUrl) {
    throw new Error('Missing R2_SOUND_PUBLIC_URL environment variable');
  }
  // 末尾のスラッシュを除去して統一
  return publicUrl.replace(/\/$/, '');
}

/**
 * R2パブリックURLを取得
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
 * R2にファイルをアップロード
 * @param fileName - ファイル名（キー）
 * @param buffer - ファイルデータ
 * @param contentType - MIMEタイプ
 * @returns アップロードされたファイルの公開URL
 */
export async function uploadToR2(
  fileName: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  const client = getR2Client();
  const bucket = getR2Bucket();
  const publicUrl = getR2PublicUrl();

  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: fileName,
      Body: buffer,
      ContentType: contentType,
    }));

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
 * 画像バケットとは完全に別のバケット・認証情報を使用
 * @param fileName - ファイル名（キー）
 * @param buffer - ファイルデータ
 * @param contentType - MIMEタイプ（audio/mpeg, audio/wav等）
 * @returns アップロードされたファイルの公開URL
 */
export async function uploadSoundToR2(
  fileName: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  const client = getR2SoundClient();
  const bucket = getR2SoundBucket();
  const publicUrl = getR2SoundPublicUrl();

  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: fileName,
      Body: buffer,
      ContentType: contentType,
    }));

    const url = `${publicUrl}/${fileName}`;
    logger.info(`[R2 Sound] Uploaded sound file: ${fileName}, size: ${buffer.length} bytes`);
    return url;
  } catch (error) {
    logger.error('[R2 Sound] Failed to upload sound file:', error);
    throw error;
  }
}

/**
 * R2からファイルを削除
 * @param fileName - ファイル名（キー）
 */
export async function deleteFromR2(fileName: string): Promise<void> {
  const client = getR2Client();
  const bucket = getR2Bucket();

  try {
    await client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: fileName,
    }));
    logger.info(`[R2] Deleted file: ${fileName}`);
  } catch (error) {
    logger.error('[R2] Failed to delete file:', error);
    throw error;
  }
}

/**
 * R2効果音バケットからファイルを削除
 * 画像バケットとは完全に別のバケット・認証情報を使用
 * @param fileName - ファイル名（キー）
 */
export async function deleteSoundFromR2(fileName: string): Promise<void> {
  const client = getR2SoundClient();
  const bucket = getR2SoundBucket();

  try {
    await client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: fileName,
    }));
    logger.info(`[R2 Sound] Deleted sound file: ${fileName}`);
  } catch (error) {
    logger.error('[R2 Sound] Failed to delete sound file:', error);
    throw error;
  }
}

/**
 * リトライ付きR2アップロード
 * 一時的なエラー（ネットワーク障害など）の場合にリトライを行う
 * @param fileName - ファイル名（キー）
 * @param buffer - ファイルデータ
 * @param contentType - MIMEタイプ
 * @param maxRetries - 最大リトライ回数（デフォルト: 3）
 * @returns アップロードされたファイルの公開URL、またはエラー
 */
export async function uploadToR2WithRetry(
  fileName: string,
  buffer: Buffer,
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
      const transientErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'service unavailable', '503', 'NetworkingError'];
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
 * 一時的なエラー（ネットワーク障害など）の場合にリトライを行う
 * @param fileName - ファイル名（キー）
 * @param buffer - ファイルデータ
 * @param contentType - MIMEタイプ
 * @param maxRetries - 最大リトライ回数（デフォルト: 3）
 * @returns アップロードされたファイルの公開URL、またはエラー
 */
export async function uploadSoundToR2WithRetry(
  fileName: string,
  buffer: Buffer,
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
      const transientErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'service unavailable', '503', 'NetworkingError'];
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
