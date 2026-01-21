import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { logger } from './logger';

/**
 * R2 Client Configuration
 * Cloudflare R2はS3互換APIを提供するため、AWS SDKを使用
 *
 * 環境変数:
 * - R2_ENDPOINT: R2エンドポイントURL (例: https://<account_id>.r2.cloudflarestorage.com)
 * - R2_ACCESS_KEY_ID: R2アクセスキーID
 * - R2_SECRET_ACCESS_KEY: R2シークレットアクセスキー
 * - R2_BUCKET_NAME: R2バケット名
 * - R2_PUBLIC_URL: R2パブリックURL (例: https://pub-xxx.r2.dev または カスタムドメイン)
 */

// R2クライアントをシングルトンパターンで管理
// リクエストごとにクライアントを作成するとコストがかかるため
let r2ClientInstance: S3Client | null = null;

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
 * R2バケット名を取得
 */
export function getR2Bucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) {
    throw new Error('Missing R2_BUCKET_NAME environment variable');
  }
  return bucket;
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
