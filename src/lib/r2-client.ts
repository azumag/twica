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

// R2 操作は Route Handler / Server Action だけから呼ぶサーバー処理であり、失敗を
// errors テーブルへ記録できる server-only logger を使う。Worker binding の利用可否は
// 実行時に判定するが、このモジュール自体を Edge middleware から import してよいことを
// 意味しないため、middleware 到達コードとの境界は静的テストで固定している。
import { logger } from './logger.server';
import { CLOUDFLARE_R2_TRANSIENT_MARKERS } from './r2-retry-policy';

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
 * リトライ対象とする一時的なR2/ネットワーク/S3 SDKエラーのパターン（画像・効果音アップロード共通）。
 * "Unspecified error" はR2ネイティブバインディングの一時障害 (Issue #349/#348)。
 * Cloudflare R2固有のエラーコード（'(10001)' InternalError / '(10043)' ServiceUnavailable等）は
 * r2-retry-policy.ts の CLOUDFLARE_R2_TRANSIENT_MARKERS を単一の情報源としてimportする
 * （ここに直接書くと今回のバグ=片方のリストにしか登録されない、が再発するため）。
 *
 * 【Issue #980】以前は画像アップロード（uploadToR2WithRetry）だけ、呼び出し元
 * （src/app/api/upload/route.ts）で r2-retry-policy.ts の retryCloudflareR2Upload に
 * さらに二重ラップされていた。旧・画像用の内側リストはCLOUDFLARE_R2_TRANSIENT_MARKERSを
 * 意図的に除外していたため、単発のR2固有エラーコードだけでは二重にリトライされなかったが、
 * 「内側が判定するネットワーク系エラーが複数回続いた末に、内側の最大試行到達で返した
 * 最終エラーがたまたまCLOUDFLARE_R2_TRANSIENT_MARKERSにも該当する」という系列が起きると、
 * 外側もそれを一時障害と判定して再試行し、理論上の最悪ケースで試行回数・待ち時間が
 * 約3倍（4回→12回・7秒→約22秒）に肥大化しうる、上限が明示されていないリトライ構成だった。
 * その二重ラップ自体を撤去し、画像・効果音とも「このモジュールの1本のリトライループだけが
 * リトライを担う」構成に統一したため、二重リトライは構造的に発生し得ない。リトライの上限は
 * uploadToR2WithRetry/uploadSoundToR2WithRetry の maxRetries（デフォルト3）1箇所だけで
 * 決まり、最大試行回数は maxRetries+1 回、最大累計待機時間は指数バックオフの合計
 * （デフォルト値なら 1s+2s+4s=7秒）に明示的に収まる。
 */
const TRANSIENT_R2_ERROR_PATTERNS: Array<string | RegExp> = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'service unavailable',
  // 【Issue #984/#1252】裸の500/503部分文字列は、キー名やリクエストIDに
  // たまたま数字列が含まれる場合（例: photo-500.png）まで一時障害と誤判定する。
  // HTTP 500/503はいずれも一過性のサーバー障害として再試行するが、誤検知を避けるため
  // `http` / `status` という文脈語が近傍にある場合だけ対象にする。
  /\b(?:http|status)\D{0,10}(?:500|503)\b/i,
  'NetworkingError',
  'Unspecified error',
  ...CLOUDFLARE_R2_TRANSIENT_MARKERS,
];

// テストから直接検証できるようexport
export function isTransientR2Error(errorMessage: string): boolean {
  return TRANSIENT_R2_ERROR_PATTERNS.some(pattern =>
    typeof pattern === 'string'
      ? errorMessage.toLowerCase().includes(pattern.toLowerCase())
      : pattern.test(errorMessage)
  );
}

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
  return withR2UploadRetry('[R2]', () => uploadToR2(fileName, buffer, contentType), maxRetries);
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
  return withR2UploadRetry('[R2 Sound]', () => uploadSoundToR2(fileName, buffer, contentType), maxRetries);
}

/**
 * uploadToR2WithRetry / uploadSoundToR2WithRetry の共通リトライループ本体。
 * ログの接頭辞（'[R2]' / '[R2 Sound]'）とアップロード呼び出し以外は完全に同一だった
 * 2つのループの重複を解消するために1本化した。
 *
 * sleepを引数として注入可能にしているのは、テストから実際の待機（最大7秒）なしに
 * リトライ回数・バックオフ時間・打ち切り条件を検証できるようにするため
 * （r2-retry-policy.tsの旧retryCloudflareR2Uploadと同じ設計。テストは
 * tests/unit/r2-client-retry-loop.test.ts を参照）。本番呼び出し元（上記2関数）は
 * 常にデフォルトの実setTimeoutを使う。テスト専用のexportなので、本番からは
 * 上記2関数を経由してのみ呼ぶこと。
 *
 * @param logPrefix - ログメッセージの接頭辞
 * @param upload - 実際のアップロード処理（1回分）。R2の公開URLを返すかthrowする
 * @param maxRetries - 最大リトライ回数
 * @param sleep - バックオフ待機の実装（テスト用に差し替え可能。デフォルトは実setTimeout）
 */
export async function withR2UploadRetry(
  logPrefix: string,
  upload: () => Promise<string>,
  maxRetries: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms))
): Promise<{ url: string } | { error: string }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const url = await upload();
      return { url };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 一時的なエラーかどうかを判定（R2固有コード・ネットワークエラーとも、ここが唯一のリトライ層）
      const isTransient = isTransientR2Error(errorMessage);

      if (!isTransient || attempt === maxRetries) {
        return { error: errorMessage };
      }

      // 指数バックオフでリトライ
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn(`${logPrefix} Upload failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, errorMessage);
      await sleep(delay);
    }
  }

  return { error: 'Max retries exceeded' };
}
