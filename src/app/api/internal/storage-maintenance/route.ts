import { NextRequest, NextResponse } from 'next/server';
import { ERROR_MESSAGES } from '@/lib/constants';
import { constantTimeEqual } from '@/lib/crypto-utils';
import { logger } from '@/lib/logger.server';
import {
  collectUnusedSoundObjects,
  MAX_UNUSED_SOUND_DELETIONS,
  MAX_UNUSED_SOUND_MAX_OBJECTS,
  runStorageUsageReconciliation,
} from '@/lib/storage-maintenance';

/**
 * Issue #1907: ストレージ台帳の再照合・未使用効果音回収の内部実行境界。
 *
 * #1896 で残った「台帳確定失敗の検知と再照合」「設定に紐付かなかった音声の
 * 回収」は、ユーザーリクエストの同期処理では実行できない（全ユーザー分の
 * 集計・R2 list を伴う）。この route は共有シークレットで認証したうえで、
 * 外部スケジューラ（Cloudflare Cron / 運用者の CLI）から実行する。
 *
 * 設計:
 * - 秘密情報はヘッダー x-storage-maintenance-secret で運ぶ。未設定時は
 *   fail-closed（500）。URL・クエリ文字列・ログには出さない。
 * - action は reconcile と collect-unused-sounds の2つだけ。未知フィールドは
 *   拒否する（将来の隠しパラメータ誤解釈を防ぐ）。
 * - collect-unused-sounds は既定 dryRun=false だが、初回運用では dryRun=true で
 *   対象キーを確認できる。minAgeSeconds の既定は24時間で、アップロード直後の
 *   設定保存待ちオブジェクトを消さない。
 * - どちらの処理も R2 → DB の順で補償可能な操作だけを行う。R2 list の
 *   認証情報・DB 接続はアプリ本体の既存 binding を使う（新しい secret は
 *   この route の共有シークレットだけ）。
 */

const STORAGE_MAINTENANCE_SECRET_HEADER = 'x-storage-maintenance-secret';
const MAX_BODY_BYTES = 2_000;
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const;

type StorageMaintenanceRequestBody =
  | { action: 'reconcile' }
  | {
      action: 'collect-unused-sounds';
      dryRun?: boolean;
      minAgeSeconds?: number;
      maxDeletions?: number;
      maxObjects?: number;
    };

function hasOnlyAllowedKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && (value as number) > 0);
}

function parseRequestBody(raw: string): StorageMaintenanceRequestBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as Record<string, unknown>;

  if (body.action === 'reconcile') {
    if (!hasOnlyAllowedKeys(body, ['action'])) return null;
    return { action: 'reconcile' };
  }

  if (body.action === 'collect-unused-sounds') {
    if (!hasOnlyAllowedKeys(body, ['action', 'dryRun', 'minAgeSeconds', 'maxDeletions', 'maxObjects'])) {
      return null;
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return null;
    // minAgeSeconds は 1 以上のみ許可する。0 は「作成直後も回収対象」を意味し、
    // 設定保存待ちのオブジェクトを消しうるため、誤指定として拒否する。
    if (!isOptionalPositiveInteger(body.minAgeSeconds)) return null;
    if (!isOptionalPositiveInteger(body.maxDeletions)) return null;
    if (!isOptionalPositiveInteger(body.maxObjects)) return null;
    // 上限を超える値はジョブ側でも拒否されるが、呼び出し元の誤指定として
    // 400 で返す（500 にすると入力ミスと DB 障害が区別できない）。
    if (
      (body.maxDeletions !== undefined && (body.maxDeletions as number) > MAX_UNUSED_SOUND_DELETIONS)
      || (body.maxObjects !== undefined && (body.maxObjects as number) > MAX_UNUSED_SOUND_MAX_OBJECTS)
    ) {
      return null;
    }
    return {
      action: 'collect-unused-sounds',
      dryRun: body.dryRun as boolean | undefined,
      minAgeSeconds: body.minAgeSeconds as number | undefined,
      maxDeletions: body.maxDeletions as number | undefined,
      maxObjects: body.maxObjects as number | undefined,
    };
  }

  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // fail-closed: シークレット未設定なら誰でも実行できる状態にしない。
  const expectedSecret = process.env.STORAGE_MAINTENANCE_SECRET;
  if (!expectedSecret) {
    logger.error('[storage-maintenance-internal] STORAGE_MAINTENANCE_SECRET is not configured');
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  const providedSecret = request.headers.get(STORAGE_MAINTENANCE_SECRET_HEADER) || '';
  if (!providedSecret || !constantTimeEqual(expectedSecret, providedSecret)) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const rawBody = await request.text();
  if (!rawBody || rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.INVALID_REQUEST },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const body = parseRequestBody(rawBody);
  if (!body) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.INVALID_REQUEST },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const startedAt = Date.now();
  try {
    if (body.action === 'reconcile') {
      const result = await runStorageUsageReconciliation();
      logger.info('[storage-maintenance-internal] reconcile completed', {
        changed: result.changed,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        {
          action: 'reconcile',
          changed: result.changed,
          // 管理 UI/CLI で読めるよう差分を返す。大量に返さない上限を設ける。
          diffs: result.diffs.slice(0, 100),
          durationMs: Date.now() - startedAt,
        },
        { status: 200, headers: NO_STORE_HEADERS },
      );
    }

    const result = await collectUnusedSoundObjects({
      dryRun: body.dryRun,
      minAgeSeconds: body.minAgeSeconds,
      maxDeletions: body.maxDeletions,
      maxObjects: body.maxObjects,
    });
    logger.info('[storage-maintenance-internal] unused sound collection completed', {
      dryRun: result.dryRun,
      deleted: result.deleted,
      ledgerRemoved: result.ledgerRemoved,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(
      {
        action: 'collect-unused-sounds',
        result,
        durationMs: Date.now() - startedAt,
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    logger.error('[storage-maintenance-internal] job failed', {
      action: body.action,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
