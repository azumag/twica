import { NextRequest, NextResponse } from 'next/server';
import { getSession, canUseStreamerFeatures } from '@/lib/session';
import { handleApiError, handleBlobError } from '@/lib/error-handler';
import { checkRateLimit, rateLimits, getRateLimitIdentifier, retryAfterSeconds } from '@/lib/rate-limit';
import { ERROR_MESSAGES, SOUND_UPLOAD_CONFIG } from '@/lib/constants';
import { getSoundFileTypeFromBuffer, getFileExtension, isValidSoundExtension } from '@/lib/file-utils';
import { logger } from '@/lib/logger.server';
import { validateCSRFToken } from '@/lib/csrf';
import { uploadSoundToR2WithRetry, deleteSoundFromR2 } from '@/lib/r2-client';
import { sha256Prefix, randomUUID } from '@/lib/crypto-utils';
import type { Session } from '@/lib/session';

interface ValidateRequestResult {
  error?: NextResponse;
  session?: Session;
}

/**
 * リクエストのバリデーション
 * セッション、レート制限、配信者権限を検証
 */
async function validateRequest(request: NextRequest): Promise<ValidateRequestResult> {
  const session = await getSession();

  // レート制限チェック（1分あたり10リクエストまで）
  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.upload, identifier, 10, 60 * 1000);

  if (!rateLimitResult.success) {
    return {
      error: NextResponse.json(
        {
          error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
          retryAfter: retryAfterSeconds(rateLimitResult.reset),
        },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(rateLimitResult.limit),
            'X-RateLimit-Remaining': String(rateLimitResult.remaining),
            'X-RateLimit-Reset': String(rateLimitResult.reset),
          },
        }
      ),
    };
  }

  if (!session) {
    return {
      error: NextResponse.json({ error: ERROR_MESSAGES.NOT_AUTHENTICATED }, { status: 401 }),
    };
  }

  // 効果音アップロードは配信者のみに許可
  // アフィリエイト/パートナーのみがガチャ機能を使用可能
  if (!canUseStreamerFeatures(session)) {
    return {
      error: NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 }),
    };
  }

  return { session };
}

/**
 * 効果音ファイルのバリデーション
 * ファイルサイズ(1MB以下)、拡張子、MIMEタイプを検証
 */
async function validateSoundFile(file: File | null): Promise<NextResponse | null> {
  if (!file) {
    return NextResponse.json({ error: ERROR_MESSAGES.NO_FILE_SELECTED }, { status: 400 });
  }

  if (!file.name || file.name.trim() === '') {
    return NextResponse.json({ error: ERROR_MESSAGES.FILE_NAME_EMPTY }, { status: 400 });
  }

  // ファイルサイズチェック（1MB制限）
  if (file.size > SOUND_UPLOAD_CONFIG.MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.SOUND_FILE_SIZE_EXCEEDED },
      { status: 400 }
    );
  }

  // 拡張子チェック
  const ext = getFileExtension(file.name);
  if (!ext || !isValidSoundExtension(ext)) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.INVALID_SOUND_FILE_TYPE },
      { status: 400 }
    );
  }

  return null;
}

/**
 * 効果音ファイルをR2にアップロード
 * 1MB制限で、MP3/WAV/WebM/OGG形式をサポート
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // CSRFトークン検証
  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    );
  }

  // リクエストとセッション検証
  const { error: rateLimitError, session } = await validateRequest(request);
  if (rateLimitError) {
    return rateLimitError;
  }

  let buffer: Buffer | null = null;
  let fileName: string | null = null;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    // ファイルバリデーション
    const fileValidationError = await validateSoundFile(file);
    if (fileValidationError) {
      return fileValidationError;
    }

    const ext = getFileExtension(file!.name);
    buffer = Buffer.from(await file!.arrayBuffer());

    // マジックナンバーによる実際のファイルタイプ検証
    // 拡張子偽装を防止するため、ファイル内容から実際の形式を判定
    const actualType = getSoundFileTypeFromBuffer(buffer);
    const expectedType = SOUND_UPLOAD_CONFIG.EXT_TO_MIME_TYPE[ext as keyof typeof SOUND_UPLOAD_CONFIG.EXT_TO_MIME_TYPE];

    if (actualType !== expectedType) {
      logger.warn(`Sound file content does not match extension. Expected: ${expectedType}, Actual: ${actualType}`);
      return NextResponse.json(
        { error: ERROR_MESSAGES.SOUND_CONTENT_MISMATCH },
        { status: 400 }
      );
    }

    // ファイル名生成: sound_{userPrefix}_{uniqueSuffix}.{ext}
    // "sound_"プレフィックスで画像ファイルと区別
    // Web Crypto APIを使用（Cloudflare Workers互換）
    const userPrefix = await sha256Prefix(session!.twitchUserId);
    // suffixはtwitchUserId+Date.now()由来のsha256Prefix(8hex)だと総当りで再現できた
    // (#832、画像アップロードと同型)。crypto.randomUUID()（推測不能）に変更する。
    const uniqueSuffix = randomUUID();

    fileName = `sound_${userPrefix}_${uniqueSuffix}.${ext}`;

    // R2効果音バケットにアップロード（リトライ付き）
    const uploadResult = await uploadSoundToR2WithRetry(fileName, buffer, actualType);

    if ('error' in uploadResult) {
      return handleBlobError(
        new Error(uploadResult.error),
        "Sound Upload API: Failed to upload to R2",
        { userId: session!.twitchUserId, fileName, fileSize: buffer.length }
      );
    }

    logger.info(`[Sound Upload] Successfully uploaded: ${fileName}, size: ${buffer.length} bytes`);
    return NextResponse.json({ url: uploadResult.url });
  } catch (error) {
    // R2アップロードエラーのハンドリング
    const storageError = error instanceof Error && (
      error.message.includes('quota') ||
      error.message.includes('limit') ||
      error.message.includes('authentication') ||
      error.message.includes('service unavailable') ||
      error.message.includes('AccessDenied') ||
      error.message.includes('NetworkingError')
    );

    if (storageError) {
      return handleBlobError(
        error,
        "Sound Upload API: R2 storage error",
        { userId: session?.twitchUserId, fileName: fileName || 'unknown', fileSize: buffer?.length }
      );
    }

    return handleApiError(error, "Sound Upload API");
  }
}

/**
 * 効果音ファイルをR2から削除
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  // CSRFトークン検証
  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    );
  }

  // リクエストとセッション検証
  const { error: rateLimitError, session } = await validateRequest(request);
  if (rateLimitError) {
    return rateLimitError;
  }

  try {
    const { url } = await request.json();

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { error: ERROR_MESSAGES.INVALID_REQUEST },
        { status: 400 }
      );
    }

    // URLからファイル名を抽出
    // 例: https://bucket.r2.dev/sound_abc12345_def67890.mp3 -> sound_abc12345_def67890.mp3
    const fileName = url.split('/').pop();
    if (!fileName) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.INVALID_REQUEST },
        { status: 400 }
      );
    }

    // ファイル名からユーザープレフィックスを検証
    // 自分のファイルのみ削除可能にするためのセキュリティチェック
    // Web Crypto APIを使用（Cloudflare Workers互換）
    const userPrefix = await sha256Prefix(session!.twitchUserId);

    // "sound_"プレフィックス + ユーザープレフィックスの形式を検証
    if (!fileName.startsWith(`sound_${userPrefix}_`)) {
      logger.warn(`[Sound Delete] Unauthorized delete attempt: ${fileName} by user ${session!.twitchUserId}`);
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      );
    }

    // R2から削除
    await deleteSoundFromR2(fileName);

    logger.info(`[Sound Delete] Successfully deleted: ${fileName}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Sound Delete API");
  }
}
