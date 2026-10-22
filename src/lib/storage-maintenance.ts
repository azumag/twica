/**
 * Storage maintenance jobs (Issue #1907)
 *
 * #1896 の残項目のうち、リクエスト経路からは実行できない2つのジョブを提供する。
 *
 * 1. reconcileStorageUsage()
 *    blob_files（正本）と storage_usage（キャッシュ）の差分を再照合する。
 *    台帳確定 RPC が失敗したまま残った過小計上や、全削除後に残った過大計上を
 *    修復する。DB 側の reconcile_storage_usage() が advisory lock を取るため、
 *    同時刻のアップロード/削除と競合しない。
 *
 * 2. collectUnusedSoundObjects()
 *    R2 効果音バケットを列挙し、どの配信者の設定（gacha_sound_url /
 *    gacha_sound_rules）からも参照されていないオブジェクトを回収する。
 *    アップロード直後の「設定保存がまだ終わっていない」オブジェクトを誤って
 *    消さないよう、既定で24時間より新しいものは対象外にする。
 *    削除は R2 → removeBlobFile の順（音声 DELETE API と同じ順序）。
 *    R2 削除に失敗した場合は台帳を触らないため、「オブジェクト残存＆計上済み」
 *    という安全側の状態が保たれる。
 *
 * どちらも internal route から共有シークレット認証のうえで呼ぶ。
 * 定期実行は workers/error-reporter の STORAGE_MAINTENANCE_CRON（日次）が
 * 同 route を叩き、手動実行は npm run storage:maintenance が同じ route を叩く。
 */

import 'server-only';

import { like } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { withDbRetry } from '@/lib/db/retry';
import { blobFiles as blobFilesTable, streamers as streamersTable } from '@/lib/db/schema';
import { logger } from './logger.server';
import {
  deleteSoundFromR2,
  getR2SoundPublicUrl,
  listSoundObjects,
} from './r2-client';
import {
  reconcileStorageUsage,
  removeBlobFile,
  type StorageReconcileDiff,
} from './storage-db';
import { getR2KeyFromUrl } from './storage-utils';

/** 効果音の未使用回収で、作成からこの時間未満のオブジェクトは対象外にする。 */
export const DEFAULT_UNUSED_SOUND_MIN_AGE_SECONDS = 24 * 60 * 60;
/** 1 回の実行で削除する上限。Worker の実行時間・削除コストを有界にする。 */
export const DEFAULT_UNUSED_SOUND_MAX_DELETIONS = 200;
export const MAX_UNUSED_SOUND_DELETIONS = 200;
const DEFAULT_UNUSED_SOUND_MAX_OBJECTS = 10_000;
export const MAX_UNUSED_SOUND_MAX_OBJECTS = 50_000;
const MAX_REPORTED_CANDIDATE_KEYS = 100;

export interface ReconcileStorageResult {
  changed: number;
  diffs: StorageReconcileDiff[];
}

/**
 * blob_files と storage_usage を再照合する。
 * `diffs` は今回修正した行だけ（変更が無ければ空配列）。
 */
export async function runStorageUsageReconciliation(): Promise<ReconcileStorageResult> {
  const diffs = await reconcileStorageUsage();
  if (diffs.length > 0) {
    logger.warn(`[StorageMaintenance] Reconciled storage usage drift: ${diffs.length} rows`, {
      rows: diffs.slice(0, 20),
    });
  } else {
    logger.info('[StorageMaintenance] Storage usage is consistent');
  }
  return { changed: diffs.length, diffs };
}

/**
 * 配信者設定から参照されている効果音キーを集める。
 *
 * URL 全体ではなく R2 キーで比較する。R2_PUBLIC_URL のドメインを付け替えた
 * 場合でも、保存済み URL の pathname が同じなら参照済みとして扱えるため
 * （storage-utils.ts の「ドメイン付け替え時はデータ移行が必要」という既知の
 * 制約に対して、回収ジョブ側は fail-safe に倒す）。
 *
 * 無効化済みルールの URL も参照済みとして扱う。ユーザーが再有効化する可能性が
 * あり、回収ジョブが設定を壊してはいけないため。
 */
export async function collectReferencedSoundKeys(): Promise<Set<string>> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          id: streamersTable.id,
          url: streamersTable.gacha_sound_url,
          rules: streamersTable.gacha_sound_rules,
        })
        .from(streamersTable);
    },
    'storageMaintenance(referencedSoundKeys)',
    // 読み取り専用クエリのため冪等（リトライ可）
    { idempotent: true },
  );

  const keys = new Set<string>();
  const addUrl = (value: unknown): void => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const key = getR2KeyFromUrl(value);
    // 効果音バケットのキーだけを対象にする（外部URLや画像キーを誤って
    // 「参照済み」に数えて回収を止めないため）。
    if (key && key.startsWith('sound_')) {
      keys.add(key);
    }
  };

  for (const row of rows) {
    addUrl(row.url);
    // 通常 postgres.js は JSONB を配列として返すが、ドライバ設定や将来の
    // パーサ変更で文字列のまま返っても参照済み判定を落とさない（誤削除防止）。
    let rules: unknown = row.rules;
    if (typeof rules === 'string') {
      try {
        rules = JSON.parse(rules);
      } catch {
        // 参照不明のまま回収を進めると、設定から参照されている効果音を
        // 誤削除しうる。ジョブ全体を失敗させ、次回実行に委ねる（fail-closed）。
        throw new Error(`Invalid gacha_sound_rules JSON for streamer ${String(row.id)}`);
      }
    }
    if (rules === null || rules === undefined) continue;
    if (!Array.isArray(rules)) {
      // 参照不明のまま回収を進めると誤削除しうる。想定外シェイプは fail-closed。
      throw new Error(`Unexpected gacha_sound_rules shape for streamer ${String(row.id)}`);
    }
    for (const rule of rules) {
      if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
        addUrl((rule as Record<string, unknown>).url);
      }
    }
  }

  return keys;
}

export interface CollectUnusedSoundsOptions {
  /** true なら削除せず対象キーだけ返す（初回運用確認用）。 */
  dryRun?: boolean;
  /** この秒数より新しいオブジェクトは対象外。既定24時間。 */
  minAgeSeconds?: number;
  /** 1回で削除する上限。既定200、最大1000。 */
  maxDeletions?: number;
  /** 1回で列挙する上限。既定10000、最大50000。 */
  maxObjects?: number;
}

export interface CollectUnusedSoundsResult {
  dryRun: boolean;
  scannedObjects: number;
  referencedObjects: number;
  /** 経過時間を確認できず対象外にした件数（fail-closed）。 */
  skippedUnknownAge: number;
  /** 新しすぎて対象外にした件数。 */
  skippedTooNew: number;
  candidateCount: number;
  candidateKeys: string[];
  deleted: number;
  /** removeBlobFile が台帳行を削除した件数。旧オブジェクトは0のまま。 */
  ledgerRemoved: number;
  /** 台帳行が存在しない旧オブジェクト（removeBlobFile が null）の件数。 */
  ledgerMissing: number;
  /** R2 削除に失敗した件数。台帳は触っていない。 */
  r2DeleteFailed: number;
  /** R2 から既に消えている台帳行を再照合で削除した件数。 */
  ledgerReconciled: number;
  /** R2 削除後に台帳減算が失敗し、再試行も失敗した件数。 */
  ledgerRemoveFailed: number;
  /** 台帳再照合の再試行が失敗した件数。 */
  ledgerReconcileFailed: number;
  /** list が上限で打ち切られた場合 true。次回実行で続きを回収する。 */
  listTruncated: boolean;
}

/**
 * blob_files から効果音の「保存済み URL」を key で引ける Map を作る。
 *
 * URL を現在の R2_SOUND_PUBLIC_URL から再構築すると、ドメイン付け替え後に
 * 旧 URL で記録された台帳行を引けず、R2 だけ削除して台帳が永久に残る。
 * 保存時の URL をそのまま使うことで、その非対称をなくす。
 */
async function collectSoundLedgerUrls(): Promise<Map<string, string>> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({ url: blobFilesTable.url })
        .from(blobFilesTable)
        // 画像キーは `{prefix}_{uuid}.ext`、効果音は `sound_...`。URL の
        // パス部分に `/sound_` を含む行だけを対象にする（全件ロードを避ける）。
        .where(like(blobFilesTable.url, '%/sound_%'));
    },
    'storageMaintenance(soundLedgerUrls)',
    { idempotent: true },
  );

  const byKey = new Map<string, string>();
  for (const row of rows) {
    const key = getR2KeyFromUrl(row.url);
    if (key && key.startsWith('sound_')) {
      byKey.set(key, row.url);
    }
  }
  return byKey;
}

/**
 * どの設定からも参照されていない効果音オブジェクトを回収する。
 *
 * 安全性:
 * - `uploaded` が取れないオブジェクトは削除しない（年齢判定不能）。
 * - minAgeSeconds 未満のものは削除しない（アップロード→設定保存の途中）。
 * - R2 削除が失敗したら台帳を減算しない（実際には残っているファイルを
 *   未計上にしない）。
 * - 台帳減算は removeBlobFile 経由に統一し、#1906 の音声 DELETE と同じ経路で
 *   storage_usage を減らす。
 */
export async function collectUnusedSoundObjects(
  options: CollectUnusedSoundsOptions = {},
): Promise<CollectUnusedSoundsResult> {
  const dryRun = options.dryRun === true;
  const minAgeSeconds = options.minAgeSeconds ?? DEFAULT_UNUSED_SOUND_MIN_AGE_SECONDS;
  const maxDeletions = options.maxDeletions ?? DEFAULT_UNUSED_SOUND_MAX_DELETIONS;
  const maxObjects = options.maxObjects ?? DEFAULT_UNUSED_SOUND_MAX_OBJECTS;

  // 0 は「作成直後も回収対象」を意味し、設定保存待ちのオブジェクトを消しうる。
  // route 側でも拒否しているが、ライブラリ単体の呼び出しにも同じ境界を課す。
  if (!Number.isInteger(minAgeSeconds) || minAgeSeconds < 1) {
    throw new Error(`Invalid minAgeSeconds: ${minAgeSeconds}`);
  }
  if (
    !Number.isInteger(maxDeletions) ||
    maxDeletions <= 0 ||
    maxDeletions > MAX_UNUSED_SOUND_DELETIONS
  ) {
    throw new Error(`Invalid maxDeletions: ${maxDeletions}`);
  }
  if (
    !Number.isInteger(maxObjects) ||
    maxObjects <= 0 ||
    maxObjects > MAX_UNUSED_SOUND_MAX_OBJECTS
  ) {
    throw new Error(`Invalid maxObjects: ${maxObjects}`);
  }

  const [referencedKeys, listed, ledgerUrls] = await Promise.all([
    collectReferencedSoundKeys(),
    listSoundObjects({ maxObjects }),
    collectSoundLedgerUrls(),
  ]);

  const now = Date.now();
  const minAgeMs = minAgeSeconds * 1000;
  let referencedObjects = 0;
  let skippedUnknownAge = 0;
  let skippedTooNew = 0;
  const candidates: Array<{ key: string; uploaded: Date }> = [];

  for (const object of listed.objects) {
    if (!object.key.startsWith('sound_')) continue;
    if (referencedKeys.has(object.key)) {
      referencedObjects += 1;
      continue;
    }
    if (!object.uploaded || !Number.isFinite(object.uploaded.getTime())) {
      skippedUnknownAge += 1;
      continue;
    }
    if (now - object.uploaded.getTime() < minAgeMs) {
      skippedTooNew += 1;
      continue;
    }
    candidates.push({ key: object.key, uploaded: object.uploaded });
  }

  // 古いものから回収し、上限まで処理する。
  candidates.sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime());
  const targets = candidates.slice(0, maxDeletions);

  let deleted = 0;
  let ledgerRemoved = 0;
  let ledgerMissing = 0;
  let r2DeleteFailed = 0;
  let ledgerReconciled = 0;
  let ledgerRemoveFailed = 0;
  let ledgerReconcileFailed = 0;

  if (!dryRun) {
    // 環境変数が欠けている場合は1件も削除せず失敗させる（途中まで消して止まらない）。
    const soundPublicUrl = getR2SoundPublicUrl();
    const deletedKeys = new Set<string>();
    const handledLedgerKeys = new Set<string>();
    const pendingLedgerKeys = new Set<string>();

    for (const target of targets) {
      const storedUrl = ledgerUrls.get(target.key) ?? `${soundPublicUrl}/${target.key}`;
      try {
        await deleteSoundFromR2(target.key);
        deleted += 1;
        deletedKeys.add(target.key);
      } catch (error) {
        r2DeleteFailed += 1;
        logger.error(`[StorageMaintenance] Failed to delete unused sound object: ${target.key}`, error);
        continue;
      }

      try {
        const removed = await removeBlobFile(storedUrl);
        if (removed) {
          ledgerRemoved += 1;
          handledLedgerKeys.add(target.key);
        } else {
          // 旧オブジェクト（台帳未記録）または並行実行で既に消えた行。
          ledgerMissing += 1;
        }
      } catch (error) {
        pendingLedgerKeys.add(target.key);
        logger.warn(
          `[StorageMaintenance] Failed to remove ledger row for unused sound (will retry): ${storedUrl}`,
          error,
        );
      }
    }

    // 台帳の取りこぼしを回収する:
    // - 上で減算に失敗したキー
    // - R2 一覧に存在しない台帳行（過去の削除失敗・ドメイン変更・中断）
    // list が打ち切られている場合、未列挙のキーを「R2 に無い」と断定できないため
    // 一覧が完全なときだけ後者を対象にする。保存済み URL を使うのでドメイン変更
    // 後も正しい行を消せる。
    const missingFromList = new Set<string>();
    if (!listed.truncated) {
      const listedKeys = new Set(listed.objects.map((object) => object.key));
      for (const key of ledgerUrls.keys()) {
        if (!handledLedgerKeys.has(key) && !listedKeys.has(key)) {
          missingFromList.add(key);
        }
      }
    }
    for (const key of [...pendingLedgerKeys, ...missingFromList]) {
      if (handledLedgerKeys.has(key)) continue;
      const storedUrl = ledgerUrls.get(key);
      if (!storedUrl) {
        if (pendingLedgerKeys.has(key)) {
          ledgerRemoveFailed += 1;
        }
        continue;
      }
      try {
        const removed = await removeBlobFile(storedUrl);
        if (removed) {
          ledgerReconciled += 1;
          handledLedgerKeys.add(key);
        } else if (pendingLedgerKeys.has(key)) {
          // 行が既に無い（並行実行・前回の delete だけ成功）なら失敗ではない。
          ledgerMissing += 1;
        }
      } catch (error) {
        if (pendingLedgerKeys.has(key)) {
          ledgerRemoveFailed += 1;
        } else {
          ledgerReconcileFailed += 1;
        }
        logger.error(`[StorageMaintenance] Failed to reconcile ledger row: ${storedUrl}`, error);
      }
    }
  }

  const result: CollectUnusedSoundsResult = {
    dryRun,
    scannedObjects: listed.objects.length,
    referencedObjects,
    skippedUnknownAge,
    skippedTooNew,
    candidateCount: candidates.length,
    candidateKeys: targets.slice(0, MAX_REPORTED_CANDIDATE_KEYS).map((target) => target.key),
    deleted,
    ledgerRemoved,
    ledgerMissing,
    r2DeleteFailed,
    ledgerReconciled,
    ledgerRemoveFailed,
    ledgerReconcileFailed,
    listTruncated: listed.truncated,
  };

  logger.info('[StorageMaintenance] Unused sound collection completed', result);
  return result;
}
