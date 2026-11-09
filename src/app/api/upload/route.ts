import { NextRequest, NextResponse } from 'next/server';
import { getSession, canUseStreamerFeatures } from '@/lib/session';
import { handleApiError, handleBlobError } from '@/lib/error-handler';
import { validateUpload, getUploadErrorMessage } from '@/lib/upload-validation';
import { checkRateLimit, rateLimits, getRateLimitIdentifier, retryAfterSeconds } from '@/lib/rate-limit';
import { ERROR_MESSAGES, UPLOAD_CONFIG, STORAGE_LIMIT_MESSAGES } from '@/lib/constants';
import { getFileTypeFromBuffer, getFileExtension, isValidExtension } from '@/lib/file-utils';
import { logger } from '@/lib/logger.server';
import { validateCSRFToken } from '@/lib/csrf';
import { uploadToR2WithRetry, deleteFromR2 } from '@/lib/r2-client';
import { recordBlobFile, releaseStorageReservation } from '@/lib/storage-db';
import { getStorageUsage, reserveStorageCapacity } from '@/lib/storage-usage';
import { sha256Prefix, randomUUID } from '@/lib/crypto-utils';
import { getUserPlan, PLAN_MAX_UPLOAD_SIZE } from '@/lib/plan';
import type { Session } from '@/lib/session';

interface ValidateRequestResult {
  error?: NextResponse;
  session?: Session;
}

async function validateRequest(request: NextRequest): Promise<ValidateRequestResult> {
  const session = await getSession();

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

  // カード画像アップロードは配信者機能なので、配信者権限を必須にする (#832)
  // これが無いと任意のTwitchアカウントで公開R2への恒久URLを取得できてしまう
  if (!canUseStreamerFeatures(session)) {
    return {
      error: NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 }),
    };
  }

  return { session };
}

async function validateFile(file: File | null, maxFileSize?: number): Promise<NextResponse | null> {
  if (!file) {
    return NextResponse.json({ error: ERROR_MESSAGES.NO_FILE_SELECTED }, { status: 400 });
  }

  if (!file.name || file.name.trim() === '') {
    return NextResponse.json({ error: ERROR_MESSAGES.FILE_NAME_EMPTY }, { status: 400 });
  }

  // プラン別のmaxFileSizeが指定されている場合はそちらを使用
  const validation = validateUpload(file, maxFileSize);
  if (!validation.valid) {
    return NextResponse.json(
      { error: getUploadErrorMessage(validation.error!) },
      { status: 400 }
    );
  }

  const ext = getFileExtension(file.name);
  if (!ext) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.INVALID_FILE_TYPE },
      { status: 400 }
    );
  }

  if (!isValidExtension(ext)) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.INVALID_FILE_TYPE },
      { status: 400 }
    );
  }

  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  const { error: rateLimitError, session } = await validateRequest(request);
  if (rateLimitError) {
    return rateLimitError;
  }

  // 早期チェック: 既に上限到達しているユーザーは multipart body を読む前に拒否する
  // （帯域・メモリの無駄を避ける）。追加バイト数を含む最終判定は保存直前の
  // reserveStorageCapacity が原子的に行う (#1907)。ここで取得した usage を予約側へ
  // 渡すことで、以前の「1リクエストで getStorageUsage を2回呼ぶ」重複を解消する。
  const userPrefix = await sha256Prefix(session!.twitchUserId);
  const initialUsage = await getStorageUsage(userPrefix, session!.twitchUserId);

  if (initialUsage.globalLimitReached) {
    return NextResponse.json(
      { error: STORAGE_LIMIT_MESSAGES.GLOBAL_LIMIT_REACHED, code: 'GLOBAL_LIMIT_REACHED' },
      { status: 507 } // Insufficient Storage
    );
  }
  if (initialUsage.userLimitReached) {
    return NextResponse.json(
      { error: STORAGE_LIMIT_MESSAGES.USER_LIMIT_REACHED, code: 'USER_LIMIT_REACHED' },
      { status: 507 } // Insufficient Storage
    );
  }

  let buffer: Buffer | null = null
  let fileName: string | null = null
  let reservationId: string | null = null
  let reservationCommitted = false

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    // プラン別のアップロードサイズ上限を適用
    const plan = await getUserPlan(session!.twitchUserId);
    const maxFileSize = PLAN_MAX_UPLOAD_SIZE[plan];

    const fileValidationError = await validateFile(file, maxFileSize);
    if (fileValidationError) {
      return fileValidationError;
    }

    const ext = getFileExtension(file!.name);
    buffer = Buffer.from(await file!.arrayBuffer());
    const actualType = getFileTypeFromBuffer(buffer);

    const expectedType = UPLOAD_CONFIG.EXT_TO_MIME_TYPE[ext as keyof typeof UPLOAD_CONFIG.EXT_TO_MIME_TYPE];

    if (actualType !== expectedType) {
      logger.warn(`File content does not match extension. Expected: ${expectedType}, Actual: ${actualType}`);
      return NextResponse.json(
        { error: ERROR_MESSAGES.FILE_CONTENT_MISMATCH },
        { status: 400 }
      );
    }

    // ファイル名と台帳のプレフィックスは、早期チェックで生成した userPrefix を
    // そのまま使う（同じリクエスト内で sha256Prefix を再計算しない）。
    // suffixはtwitchUserId+Date.now()由来のsha256Prefix(8hex)だと、公開情報である
    // twitchUserIdとミリ秒単位のDate.now()から総当りで再現できた (#832)。
    // crypto.randomUUID()（128bit・推測不能）に変更する。
    const uniqueSuffix = randomUUID();

    // Format: {userPrefix}_{uniqueSuffix}.{ext}
    fileName = `${userPrefix}_${uniqueSuffix}.${ext}`;

    // 容量を原子的に予約する (#1907)。上限判定は DB が
    // 「確定済み使用量 + 有効な予約」で行うため、同一ユーザー・並列ユーザーの
    // どちらでも R2 保存前に上限を超えない。予約に失敗した場合は R2 へ進まない。
    const reservation = await reserveStorageCapacity(
      userPrefix,
      session!.twitchUserId,
      buffer!.length,
      initialUsage,
    );
    if (!reservation.ok) {
      return NextResponse.json(
        reservation.reason === 'global_limit'
          ? { error: STORAGE_LIMIT_MESSAGES.GLOBAL_LIMIT_REACHED, code: 'GLOBAL_LIMIT_REACHED' }
          : { error: STORAGE_LIMIT_MESSAGES.USER_LIMIT_REACHED, code: 'USER_LIMIT_REACHED' },
        { status: 507 } // Insufficient Storage
      );
    }
    const activeReservationId = reservation.reservationId;
    reservationId = activeReservationId;

    // R2にアップロード（Vercel Blobの代わり）
    // uploadToR2WithRetry自体がR2固有エラーコード込みでリトライする単一のリトライループ
    // なので、ここで別のリトライラッパーに包まない（二重リトライで待ち時間が肥大化する
    // 問題があったため撤去した。Issue #980）
    const uploadResult = await uploadToR2WithRetry(fileName!, buffer!, actualType);

    if ('error' in uploadResult) {
      return handleBlobError(
        new Error(uploadResult.error),
        "Upload API: Failed to upload to R2",
        { userId: session!.twitchUserId, fileName, fileSize: buffer.length }
      )
    }

    // 予約を確定し、blob_files と使用量カウンタを同一 RPC で更新する (#1907)。
    // 旧実装は INSERT とカウンタ更新が別文で、カウンタ更新の失敗を握りつぶしていた。
    // ここで失敗した場合は例外/結果で検知し、R2 オブジェクトと予約を補償する。
    try {
      const commitOutcome = await recordBlobFile(
        activeReservationId,
        uploadResult.url,
        userPrefix,
        buffer!.length,
        'r2',
      );
      if (commitOutcome === 'reservation_not_found') {
        throw new Error('storage reservation not found when committing blob file');
      }
    } catch (dbError) {
      // 台帳確定失敗: このまま返すと「R2保存済み・未計上・未参照」の孤児オブジェクトが
      // 残り、クライアントのリトライのたびに未計上容量が増殖する (#1896)。
      // 保存直後のオブジェクトを best-effort で削除して台帳と R2 の整合を取り、
      // 削除にも失敗した場合はログを残して follow-up の回収対象にする。
      try {
        await deleteFromR2(fileName!);
      } catch (cleanupError) {
        logger.error(`Failed to cleanup R2 object after ledger failure: ${fileName}`, cleanupError);
      }
      logger.error(`Failed to record blob file in DB: ${fileName}`, dbError);
      return NextResponse.json(
        { error: ERROR_MESSAGES.INTERNAL_ERROR, code: 'STORAGE_LEDGER_FAILED' },
        { status: 500 }
      );
    }

    reservationCommitted = true;
    return NextResponse.json({ url: uploadResult.url });
  } catch (error) {
    // R2またはDB操作でのエラーをハンドリング
    const storageError = error instanceof Error && (
      error.message.includes('quota') ||
      error.message.includes('limit') ||
      error.message.includes('authentication') ||
      error.message.includes('service unavailable') ||
      error.message.includes('AccessDenied') ||
      error.message.includes('NetworkingError')
    )

    if (storageError) {
      return handleBlobError(
        error,
        "Upload API: R2 storage error",
        { userId: session?.twitchUserId, fileName: fileName || 'unknown', fileSize: buffer?.length }
      )
    }

    return handleApiError(error, "Upload API");
  } finally {
    // R2 保存失敗・検証エラー・台帳確定失敗のいずれでも、確定していない予約は
    // 必ず解放する。解放自体の失敗は容量を TTL まで占有するだけ（安全側）なので
    // ログに残し、レスポンスは元のエラーを優先する。
    if (reservationId && !reservationCommitted) {
      try {
        await releaseStorageReservation(reservationId);
      } catch (releaseError) {
        logger.error(`Failed to release storage reservation: ${reservationId}`, releaseError);
      }
    }
  }
}
