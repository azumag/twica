import { NextRequest, NextResponse } from 'next/server';
import { getSession, canUseStreamerFeatures } from '@/lib/session';
import { handleApiError, handleBlobError } from '@/lib/error-handler';
import { checkRateLimit, rateLimits, getRateLimitIdentifier, retryAfterSeconds } from '@/lib/rate-limit';
import { ERROR_MESSAGES, SOUND_UPLOAD_CONFIG, STORAGE_LIMIT_MESSAGES } from '@/lib/constants';
import { getSoundFileTypeFromBuffer, getFileExtension, isValidSoundExtension } from '@/lib/file-utils';
import { logger } from '@/lib/logger.server';
import { validateCSRFToken } from '@/lib/csrf';
import { uploadSoundToR2WithRetry, deleteSoundFromR2 } from '@/lib/r2-client';
import { recordBlobFile, removeBlobFile } from '@/lib/storage-db';
import { getStorageUsage } from '@/lib/storage-usage';
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

    // 容量予約: 音声も累積使用量の対象にする (#1896)
    // - 取得失敗時の fail-closed フォールバックは「usage=0 / flags=true」で返るため、
    //   フラグを先に見ないとバイト比較を素通しして無制限保存に進む
    //   （完了条件: 容量が取得不能な場合に無制限保存へ進めない）
    // - 正常時は追加バイト数を含めて判定する（現在使用量だけの判定だと
    //   上限直前の追加アップロードで突破できる）
    const preUploadUsage = await getStorageUsage(userPrefix, session!.twitchUserId);
    if (preUploadUsage.globalLimitReached ||
        preUploadUsage.globalUsage + buffer!.length > preUploadUsage.globalLimitBytes) {
      return NextResponse.json(
        { error: STORAGE_LIMIT_MESSAGES.GLOBAL_LIMIT_REACHED, code: 'GLOBAL_LIMIT_REACHED' },
        { status: 507 }
      );
    }
    if (preUploadUsage.userLimitReached ||
        preUploadUsage.userUsage + buffer!.length > preUploadUsage.userLimitBytes) {
      return NextResponse.json(
        { error: STORAGE_LIMIT_MESSAGES.USER_LIMIT_REACHED, code: 'USER_LIMIT_REACHED' },
        { status: 507 }
      );
    }

    // R2効果音バケットにアップロード（リトライ付き）
    const uploadResult = await uploadSoundToR2WithRetry(fileName, buffer, actualType);

    if ('error' in uploadResult) {
      return handleBlobError(
        new Error(uploadResult.error),
        "Sound Upload API: Failed to upload to R2",
        { userId: session!.twitchUserId, fileName, fileSize: buffer.length }
      );
    }

    try {
      await recordBlobFile(uploadResult.url, userPrefix, buffer!.length, 'r2');
    } catch (dbError) {
      // 台帳確定失敗: このまま返すと「R2保存済み・未計上・未参照」の孤児オブジェクトが
      // 残り、クライアントのリトライのたびに未計上容量が増殖する (#1896)。
      // 保存直後のオブジェクトを best-effort で削除して台帳と R2 の整合を取り、
      // 削除にも失敗した場合はログを残して follow-up の回収対象にする。
      try {
        await deleteSoundFromR2(fileName);
      } catch (cleanupError) {
        logger.error(`[Sound Upload] Failed to cleanup R2 object after ledger failure: ${fileName}`, cleanupError);
      }
      logger.error(`[Sound Upload] Failed to record sound blob file in DB: ${fileName}`, dbError);
      return NextResponse.json(
        { error: ERROR_MESSAGES.INTERNAL_ERROR, code: 'STORAGE_LEDGER_FAILED' },
        { status: 500 }
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

    // 台帳からも削除して使用量を減算する (#1896)。
    // 音声は #1896 から recordBlobFile で台帳記録対象のため、R2 削除のみだと
    // 使用量が残り続けて正当なアップロードが上限誤ブロックされる。
    // - 台帳未記録の旧オブジェクト（記録導入前の音声）は removeBlobFile が
    //   null を返すため減算スキップ
    // - 減算失敗は過大計上（安全側）だが誤ブロックの原因になるため、
    //   ログで追跡し再照合の対象にする
    // - R2 削除成功後に減算する順序は、R2 削除失敗時に台帳を触らず
    //   「オブジェクト残存＆計上済み」の一貫した状態を保つため
    try {
      await removeBlobFile(url);
    } catch (ledgerError) {
      logger.error(`[Sound Delete] Failed to remove blob file from ledger: ${url}`, ledgerError);
    }

    logger.info(`[Sound Delete] Successfully deleted: ${fileName}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Sound Delete API");
  }
}
