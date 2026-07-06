/**
 * Database-based Storage Usage Management
 * DB経由でストレージ使用量を管理
 *
 * Vercel Blobの list() 操作を避けるため、使用量をDBで追跡する
 * これにより操作数制限（2,000/月）を大幅に節約できる
 */

import { cache } from 'react';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { UPLOAD_CONFIG, VOTE_CAMPAIGN_CONFIG } from './constants';
import { logger } from './logger';
// -----------------------------------------------------------------------------
// #572 (#570 パイロット踏襲): pg 直結経路。
// - blob_files への書き込み（recordBlobFile / removeBlobFile）は読み書き混在の
//   関数のため isPgWriteEnabled() で関数全体を分岐する（token-manager.ts 冒頭の
//   フラグ使い分け方針と同じ）。
// - streamers 経由のボーナス読み取り（getStorageBonusBytes /
//   hasStorageBonusByTwitchUserId）は読み取り専用のため isPgReadEnabled() で分岐。
// - RPC update_storage_usage はイシュー区分上 #573 だが、呼び出し元 2 箇所が
//   本ファイルの書き込み関数内に閉じているため、同一ファイルを 2 段階で触らず
//   ここで一括置換する（getDb() の sql タグで
//   `select update_storage_usage(p_xxx => ...)` を名前付き引数呼び出しする）。
// 既存 supabase-js 実装は 1 文字も変えず、フラグ未設定時は完全に従来どおり動く。
// -----------------------------------------------------------------------------
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { isPgReadEnabled, isPgWriteEnabled } from '@/lib/db/flags';
import { withDbRetry } from '@/lib/db/retry';
import {
  blobFiles as blobFilesTable,
  streamers as streamersTable,
  streamerStorageBonus as streamerStorageBonusTable,
} from '@/lib/db/schema';

// グローバル使用量を識別する特殊プレフィックス
const GLOBAL_PREFIX = '_global_';

export interface StorageUsageResult {
  userUsage: number;
  globalUsage: number;
  userLimitReached: boolean;
  globalLimitReached: boolean;
  userLimitBytes: number;
  globalLimitBytes: number;
}

export interface BlobFileInfo {
  userPrefix: string;
  fileSize: number;
  storageType: 'r2' | 'vercel';
}

/**
 * DBからストレージ使用量を取得
 * Vercel Blobの list() を使わずに使用量を計算
 *
 * @param userPrefix - ユーザー識別用のプレフィックス（8文字のハッシュ）
 * @returns ストレージ使用量情報
 */
export async function getStorageUsageFromDB(userPrefix: string): Promise<StorageUsageResult> {
  try {
    const supabaseAdmin = getSupabaseAdmin();

    // ユーザーとグローバルの使用量を同時に取得
    const { data, error } = await supabaseAdmin
      .from('storage_usage')
      .select('user_prefix, bytes_used')
      .in('user_prefix', [userPrefix, GLOBAL_PREFIX]);

    if (error) {
      logger.error('[StorageDB] Failed to get storage usage:', error);
      throw new Error(`Failed to get storage usage: ${error.message}`);
    }

    // 結果を解析
    const userRow = data?.find(r => r.user_prefix === userPrefix);
    const globalRow = data?.find(r => r.user_prefix === GLOBAL_PREFIX);

    const userUsage = userRow?.bytes_used ?? 0;
    const globalUsage = globalRow?.bytes_used ?? 0;

    logger.info(`[StorageDB] Usage - User: ${userPrefix} = ${userUsage} bytes, Global = ${globalUsage} bytes`);

    return {
      userUsage,
      globalUsage,
      userLimitReached: userUsage >= UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitReached: globalUsage >= UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    };
  } catch (error) {
    // 使用量を確認できない場合は、アップロードをブロックしないように制限に達していないと仮定
    // ただし、エラーログは出力する
    logger.error('[StorageDB] Failed to get storage usage, returning defaults:', error);
    return {
      userUsage: 0,
      globalUsage: 0,
      userLimitReached: false,
      globalLimitReached: false,
      userLimitBytes: UPLOAD_CONFIG.USER_STORAGE_LIMIT,
      globalLimitBytes: UPLOAD_CONFIG.GLOBAL_STORAGE_LIMIT,
    };
  }
}

/**
 * ファイル情報をDBに記録（アップロード時）
 * 使用量テーブルも同時に更新する
 *
 * @param url - アップロードされたファイルのURL
 * @param userPrefix - ユーザー識別用のプレフィックス
 * @param fileSize - ファイルサイズ（バイト）
 * @param storageType - ストレージの種類 ('r2' or 'vercel')
 */
/**
 * recordBlobFile の pg 直結実装 (#572)
 *
 * PostgREST 実装との対応:
 * - blob_files INSERT の失敗は log + `Failed to record blob file: ...` の throw、
 *   外側 catch の log + 再 throw まで同じ流れ（エラーメッセージ本文はドライバ由来で
 *   異なるが、Error の形状・プレフィックスは同一）。
 * - RPC update_storage_usage（migration 00006 で定義）は sql タグの
 *   名前付き引数呼び出し（p_xxx => 値）に置換。supabase-js の
 *   .rpc('update_storage_usage', { p_user_prefix, ... }) と同じ名前ベースの束縛で、
 *   将来の引数追加・並び替えに対して位置引数より安全。
 * - RPC の失敗はログのみで throw しない（次回の計算で補正される。既存と同じ）。
 */
async function recordBlobFilePg(
  url: string,
  userPrefix: string,
  fileSize: number,
  storageType: 'r2' | 'vercel'
): Promise<void> {
  try {
    // ファイル情報を記録
    try {
      await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { db } = await getDb();
          return db.insert(blobFilesTable).values({
            url,
            user_prefix: userPrefix,
            file_size: fileSize,
            storage_type: storageType,
          });
        },
        'recordBlobFile(insert)',
        // ON CONFLICT の無い INSERT（url が PK）は再実行で一意制約違反になりうる
        // ため非冪等（既定 = リトライなし）
      );
    } catch (insertError) {
      logger.error('[StorageDB] Failed to insert blob file record:', insertError);
      throw new Error(
        `Failed to record blob file: ${insertError instanceof Error ? insertError.message : String(insertError)}`
      );
    }

    // 使用量を更新（ユーザーとグローバル）
    try {
      await withDbRetry(
        async () => {
          const { sql } = await getDb();
          return sql`select update_storage_usage(p_user_prefix => ${userPrefix}, p_size_delta => ${fileSize}, p_count_delta => ${1})`;
        },
        'recordBlobFile(rpc:update_storage_usage)',
        // 使用量カウンタの加算は再実行で二重加算になるため非冪等（既定 = リトライなし）
      );
    } catch (rpcError) {
      logger.error('[StorageDB] Failed to update storage usage:', rpcError);
      // ファイル記録は成功したが使用量更新が失敗した場合、ログを出すが例外は投げない
      // 次回の計算で補正される
    }

    logger.info(`[StorageDB] Recorded blob file: ${url}, size: ${fileSize}, type: ${storageType}`);
  } catch (error) {
    logger.error('[StorageDB] Error recording blob file:', error);
    throw error;
  }
}

export async function recordBlobFile(
  url: string,
  userPrefix: string,
  fileSize: number,
  storageType: 'r2' | 'vercel'
): Promise<void> {
  // #572: 書き込み（INSERT + RPC）を含む関数のため isPgWriteEnabled() で分岐。
  // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
  if (isPgWriteEnabled()) {
    return recordBlobFilePg(url, userPrefix, fileSize, storageType);
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // ファイル情報を記録
    const { error: insertError } = await supabaseAdmin
      .from('blob_files')
      .insert({
        url,
        user_prefix: userPrefix,
        file_size: fileSize,
        storage_type: storageType,
      });

    if (insertError) {
      logger.error('[StorageDB] Failed to insert blob file record:', insertError);
      throw new Error(`Failed to record blob file: ${insertError.message}`);
    }

    // 使用量を更新（ユーザーとグローバル）
    // Supabaseの rpc() を使ってストアドファンクションを呼び出す
    const { error: rpcError } = await supabaseAdmin.rpc('update_storage_usage', {
      p_user_prefix: userPrefix,
      p_size_delta: fileSize,
      p_count_delta: 1,
    });

    if (rpcError) {
      logger.error('[StorageDB] Failed to update storage usage:', rpcError);
      // ファイル記録は成功したが使用量更新が失敗した場合、ログを出すが例外は投げない
      // 次回の計算で補正される
    }

    logger.info(`[StorageDB] Recorded blob file: ${url}, size: ${fileSize}, type: ${storageType}`);
  } catch (error) {
    logger.error('[StorageDB] Error recording blob file:', error);
    throw error;
  }
}

/**
 * ファイル情報を取得して削除（削除時）
 * 使用量テーブルも同時に更新する
 *
 * @param url - 削除するファイルのURL
 * @returns ファイル情報（userPrefix, fileSize, storageType）、存在しない場合はnull
 */
/**
 * removeBlobFile の pg 直結実装 (#572)
 *
 * PostgREST 実装との対応:
 * - blob_files の .maybeSingle() は url が PK のため LIMIT 1 + rows[0] ?? null で
 *   同じ外部挙動（0 行は warn ログ + null）。
 * - DELETE 失敗は log + `Failed to delete blob file: ...` の throw、外側 catch で
 *   log + 再 throw（recordBlobFilePg と同様、メッセージ本文以外は同一の流れ）。
 * - RPC update_storage_usage は負の delta での減算（recordBlobFilePg の
 *   コメント参照）。失敗はログのみで throw しない（既存と同じ）。
 */
async function removeBlobFilePg(url: string): Promise<BlobFileInfo | null> {
  try {
    // ファイル情報を取得
    let data: { user_prefix: string; file_size: number; storage_type: string } | null;
    try {
      const rows = await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { db } = await getDb();
          return db
            .select({
              user_prefix: blobFilesTable.user_prefix,
              file_size: blobFilesTable.file_size,
              storage_type: blobFilesTable.storage_type,
            })
            .from(blobFilesTable)
            .where(eq(blobFilesTable.url, url))
            .limit(1);
        },
        'removeBlobFile(select)',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      );
      data = rows[0] ?? null;
    } catch (selectError) {
      logger.error('[StorageDB] Failed to get blob file record:', selectError);
      throw new Error(
        `Failed to get blob file: ${selectError instanceof Error ? selectError.message : String(selectError)}`
      );
    }

    if (!data) {
      logger.warn(`[StorageDB] Blob file not found in DB: ${url}`);
      return null;
    }
    const fileInfo = data;

    // ファイル情報を削除
    try {
      await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db.delete(blobFilesTable).where(eq(blobFilesTable.url, url));
        },
        'removeBlobFile(delete)',
        // PK（url）指定の DELETE は再実行しても最終状態が同じ（2 回目は 0 行削除）
        // ため冪等（リトライ可）
        { idempotent: true },
      );
    } catch (deleteError) {
      logger.error('[StorageDB] Failed to delete blob file record:', deleteError);
      throw new Error(
        `Failed to delete blob file: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
      );
    }

    // 使用量を減算（ユーザーとグローバル）
    try {
      await withDbRetry(
        async () => {
          const { sql } = await getDb();
          return sql`select update_storage_usage(p_user_prefix => ${fileInfo.user_prefix}, p_size_delta => ${-fileInfo.file_size}, p_count_delta => ${-1})`;
        },
        'removeBlobFile(rpc:update_storage_usage)',
        // 使用量カウンタの減算は再実行で二重減算になるため非冪等（既定 = リトライなし）
      );
    } catch (rpcError) {
      logger.error('[StorageDB] Failed to update storage usage after delete:', rpcError);
      // 使用量更新が失敗してもファイル削除は成功したのでログのみ
    }

    logger.info(`[StorageDB] Removed blob file: ${url}, size: ${fileInfo.file_size}`);

    return {
      userPrefix: fileInfo.user_prefix,
      fileSize: fileInfo.file_size,
      storageType: fileInfo.storage_type as 'r2' | 'vercel',
    };
  } catch (error) {
    logger.error('[StorageDB] Error removing blob file:', error);
    throw error;
  }
}

export async function removeBlobFile(url: string): Promise<BlobFileInfo | null> {
  // #572: 読み取り（削除対象の逆引き）と書き込み（DELETE + RPC）が混在する関数の
  // ため isPgWriteEnabled() で関数全体を分岐。
  if (isPgWriteEnabled()) {
    return removeBlobFilePg(url);
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // ファイル情報を取得
    const { data, error: selectError } = await supabaseAdmin
      .from('blob_files')
      .select('user_prefix, file_size, storage_type')
      .eq('url', url)
      .maybeSingle();

    // maybeSingle()を使用しているため、行が見つからない場合はerrorではなくdata=nullが返る
    if (selectError) {
      logger.error('[StorageDB] Failed to get blob file record:', selectError);
      throw new Error(`Failed to get blob file: ${selectError.message}`);
    }

    if (!data) {
      logger.warn(`[StorageDB] Blob file not found in DB: ${url}`);
      return null;
    }

    // ファイル情報を削除
    const { error: deleteError } = await supabaseAdmin
      .from('blob_files')
      .delete()
      .eq('url', url);

    if (deleteError) {
      logger.error('[StorageDB] Failed to delete blob file record:', deleteError);
      throw new Error(`Failed to delete blob file: ${deleteError.message}`);
    }

    // 使用量を減算（ユーザーとグローバル）
    const { error: rpcError } = await supabaseAdmin.rpc('update_storage_usage', {
      p_user_prefix: data.user_prefix,
      p_size_delta: -data.file_size,
      p_count_delta: -1,
    });

    if (rpcError) {
      logger.error('[StorageDB] Failed to update storage usage after delete:', rpcError);
      // 使用量更新が失敗してもファイル削除は成功したのでログのみ
    }

    logger.info(`[StorageDB] Removed blob file: ${url}, size: ${data.file_size}`);

    return {
      userPrefix: data.user_prefix,
      fileSize: data.file_size,
      storageType: data.storage_type as 'r2' | 'vercel',
    };
  } catch (error) {
    logger.error('[StorageDB] Error removing blob file:', error);
    throw error;
  }
}

/**
 * 配信者のストレージボーナス合計を取得（バイト単位）
 * streamer_storage_bonus テーブルから該当streamerの全ボーナスを合計
 *
 * @param twitchUserId - Twitch ユーザーID
 * @returns ボーナス合計（バイト単位）、ボーナスなしまたはエラー時は0
 */
/**
 * getStorageBonusBytes の pg 直結実装 (#572)
 *
 * PostgREST 実装との対応:
 * - `streamers.select('streamer_storage_bonus(amount_mb)')` の埋め込みを
 *   streamers LEFT JOIN streamer_storage_bonus の 1 クエリで置き換える
 *   （往復回数のパリティ）。JOIN 条件はこの埋め込みが表す FK リレーション
 *   （streamer_storage_bonus.streamer_id → streamers.id、migration 00013）そのもの。
 * - streamers.twitch_user_id は UNIQUE（00001）のため、返る複数行はすべて同一
 *   streamer でボーナス行だけが異なる。streamer 不在（0 行）は .maybeSingle() の
 *   data=null と同じく 0 を返す。ボーナス 0 件は LEFT JOIN の不一致行
 *   （amount_mb が null の 1 行）になり、合計 0 → 0 バイト（既存と同じ結果）。
 * - エラー時 0 を返す外部挙動も同じ（pg はエラーが throw になるため catch で吸収。
 *   ログは既存 catch 節と同じメッセージで切替検証用に残る）。
 */
async function getStorageBonusBytesPg(twitchUserId: string): Promise<number> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ amount_mb: streamerStorageBonusTable.amount_mb })
          .from(streamersTable)
          .leftJoin(
            streamerStorageBonusTable,
            eq(streamerStorageBonusTable.streamer_id, streamersTable.id)
          )
          .where(eq(streamersTable.twitch_user_id, twitchUserId));
      },
      'getStorageBonusBytes',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );

    if (rows.length === 0) {
      return 0;
    }

    // MB → bytes に変換して合計（LEFT JOIN 不一致行の amount_mb は null → 0 扱い）
    const totalMb = rows.reduce((sum, row) => sum + (row.amount_mb ?? 0), 0);
    return totalMb * 1024 * 1024;
  } catch (error) {
    // ボーナス取得失敗時はゼロとする（ユーザーに不利にしない。既存と同じ）
    logger.error('[StorageDB] Failed to get storage bonus:', error);
    return 0;
  }
}

export async function getStorageBonusBytes(twitchUserId: string): Promise<number> {
  // #572: 読み取り専用の関数のため isPgReadEnabled() で分岐。
  if (isPgReadEnabled()) {
    return getStorageBonusBytesPg(twitchUserId);
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // streamersテーブル経由でstreamer_storage_bonusをリレーションで取得
    const { data, error } = await supabaseAdmin
      .from('streamers')
      .select('streamer_storage_bonus(amount_mb)')
      .eq('twitch_user_id', twitchUserId)
      .maybeSingle();

    if (error || !data) {
      return 0;
    }

    const bonuses = data.streamer_storage_bonus as Array<{ amount_mb: number }> | null;
    if (!bonuses || bonuses.length === 0) {
      return 0;
    }

    // MB → bytes に変換して合計
    const totalMb = bonuses.reduce((sum, b) => sum + b.amount_mb, 0);
    return totalMb * 1024 * 1024;
  } catch (error) {
    // ボーナス取得失敗時はゼロとする（ユーザーに不利にしない）
    // logger.error が自動的に Supabase に記録するため reportError は不要
    logger.error('[StorageDB] Failed to get storage bonus:', error);
    return 0;
  }
}

/**
 * TwitchユーザーIDで指定されたストレージボーナスが既に適用済みかチェック
 * 非配信者でも将来の恩恵を受けられるようにするため、twitch_user_id で検索
 *
 * @param twitchUserId - Twitch ユーザーID
 * @param type - ボーナスの種類
 * @param memo - 管理用メモ
 * @returns 適用済みの場合true
 */
/**
 * hasStorageBonusByTwitchUserId の pg 直結実装 (#572)
 *
 * PostgREST 実装との対応:
 * - `streamer_storage_bonus!inner(id)` + 埋め込み列への .eq() は「条件に合う
 *   ボーナスを持つ streamers 行だけを返す」INNER JOIN のため、
 *   INNER JOIN ... ON (FK 一致 AND type AND memo) が等価。存在確認だけなので
 *   LIMIT 1 で十分（.maybeSingle() は該当 streamer が最大 1 行のため同じ外部挙動）。
 * - 既存実装は error を受け取らず data の有無だけ見る（!!data）。pg 版はエラーが
 *   throw になるため、既存の catch 節と同じログ + false に落とす。
 */
async function hasStorageBonusByTwitchUserIdPg(
  twitchUserId: string,
  type: string,
  memo: string
): Promise<boolean> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ id: streamerStorageBonusTable.id })
          .from(streamersTable)
          .innerJoin(
            streamerStorageBonusTable,
            and(
              eq(streamerStorageBonusTable.streamer_id, streamersTable.id),
              eq(streamerStorageBonusTable.type, type),
              eq(streamerStorageBonusTable.memo, memo)
            )
          )
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      'hasStorageBonusByTwitchUserId',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    return rows.length > 0;
  } catch (error) {
    logger.error('[StorageDB] Failed to check storage bonus by twitch_user_id:', error);
    return false;
  }
}

export async function hasStorageBonusByTwitchUserId(
  twitchUserId: string,
  type: string,
  memo: string
): Promise<boolean> {
  // #572: 読み取り専用の関数のため isPgReadEnabled() で分岐。
  if (isPgReadEnabled()) {
    return hasStorageBonusByTwitchUserIdPg(twitchUserId, type, memo);
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    // streamers テーブル経由で streamer_storage_bonus を検索
    const { data } = await supabaseAdmin
      .from('streamers')
      .select('streamer_storage_bonus!inner(id)')
      .eq('twitch_user_id', twitchUserId)
      .eq('streamer_storage_bonus.type', type)
      .eq('streamer_storage_bonus.memo', memo)
      .maybeSingle();
    return !!data;
  } catch (error) {
    logger.error('[StorageDB] Failed to check storage bonus by twitch_user_id:', error);
    return false;
  }
}

/**
 * 投票キャンペーンボタンの表示判定
 * キャンペーン期間内 かつ 未適用の場合にtrueを返す
 * cache()でリクエスト単位のキャッシュを適用し、同一リクエスト内での重複DB呼び出しを防止
 *
 * @param twitchUserId - Twitch ユーザーID
 * @returns キャンペーンボタンを表示すべき場合true
 */
export const shouldShowVoteCampaign = cache(async function shouldShowVoteCampaign(twitchUserId: string): Promise<boolean> {
  const now = new Date();
  if (now < VOTE_CAMPAIGN_CONFIG.START_DATE || now > VOTE_CAMPAIGN_CONFIG.END_DATE) {
    return false;
  }
  return !(await hasStorageBonusByTwitchUserId(
    twitchUserId,
    VOTE_CAMPAIGN_CONFIG.TYPE,
    VOTE_CAMPAIGN_CONFIG.MEMO
  ));
})

/**
 * 全ユーザーのストレージ使用量サマリーを取得（管理用）
 *
 * @returns 全ユーザーの使用量一覧
 */
export async function getAllStorageUsage(): Promise<Array<{
  userPrefix: string;
  bytesUsed: number;
  blobCount: number;
}>> {
  try {
    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .from('storage_usage')
      .select('user_prefix, bytes_used, blob_count')
      .order('bytes_used', { ascending: false });

    if (error) {
      logger.error('[StorageDB] Failed to get all storage usage:', error);
      throw new Error(`Failed to get all storage usage: ${error.message}`);
    }

    return (data || []).map(row => ({
      userPrefix: row.user_prefix,
      bytesUsed: row.bytes_used,
      blobCount: row.blob_count,
    }));
  } catch (error) {
    logger.error('[StorageDB] Error getting all storage usage:', error);
    throw error;
  }
}
