#!/usr/bin/env node

/**
 * Initialize Storage Usage Script
 * ストレージ使用量初期化スクリプト
 *
 * このスクリプトは、既存のVercel Blobファイルの情報をDBに記録します。
 * マイグレーション後に一度だけ実行してください。
 *
 * 実行方法:
 *   node scripts/init-storage-usage.js
 *
 * 必要な環境変数:
 *   - BLOB_READ_WRITE_TOKEN: Vercel Blobのトークン
 *   - NEXT_PUBLIC_SUPABASE_URL: SupabaseのURL
 *   - SUPABASE_SERVICE_ROLE_KEY: Supabaseのサービスロールキー
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { list } = require('@vercel/blob');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createClient } = require('@supabase/supabase-js');

// グローバル使用量を識別する特殊プレフィックス
const GLOBAL_PREFIX = '_global_';

// Supabase クライアントの初期化
function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, key);
}

/**
 * ファイル名からユーザープレフィックスを抽出
 * フォーマット: {userPrefix}_{uniqueSuffix}.{ext}
 * @param {string} pathname - ファイルのパス名
 * @returns {string|null} ユーザープレフィックス（8文字）またはnull
 */
function extractUserPrefixFromPathname(pathname) {
  // パスの最後の部分（ファイル名）を取得
  const fileName = pathname.split('/').pop();
  if (!fileName) return null;

  // ファイル名から拡張子を除去
  const nameWithoutExt = fileName.split('.')[0];
  if (!nameWithoutExt) return null;

  // ユーザープレフィックスを抽出（最初の8文字）
  // フォーマット: {userPrefix}_{uniqueSuffix}
  const prefix = nameWithoutExt.split('_')[0];
  if (prefix && prefix.length === 8) {
    return prefix;
  }

  return null;
}

/**
 * 使用量を更新するSQL関数を呼び出す
 * @param {object} supabase - Supabaseクライアント
 * @param {string} userPrefix - ユーザープレフィックス
 * @param {number} sizeDelta - サイズの変化量
 * @param {number} countDelta - ファイル数の変化量
 */
async function updateStorageUsage(supabase, userPrefix, sizeDelta, countDelta) {
  const { error } = await supabase.rpc('update_storage_usage', {
    p_user_prefix: userPrefix,
    p_size_delta: sizeDelta,
    p_count_delta: countDelta,
  });

  if (error) {
    console.error(`Failed to update storage usage for ${userPrefix}:`, error);
    throw error;
  }
}

/**
 * メイン処理
 */
async function initializeStorageUsage() {
  console.log('🚀 Starting storage usage initialization...\n');

  const supabase = getSupabaseAdmin();

  // 既存のblob_filesとstorage_usageをクリア
  console.log('🧹 Clearing existing records...');

  // blob_files テーブルをクリア
  const { error: deleteFilesError } = await supabase
    .from('blob_files')
    .delete()
    .neq('url', ''); // 全レコード削除

  if (deleteFilesError) {
    console.error('Failed to clear blob_files:', deleteFilesError);
    // テーブルが存在しない場合は無視
    if (!deleteFilesError.message.includes('does not exist')) {
      throw deleteFilesError;
    }
  }

  // storage_usage テーブルをリセット（_global_以外を削除し、_global_を0にリセット）
  const { error: deleteUsageError } = await supabase
    .from('storage_usage')
    .delete()
    .neq('user_prefix', GLOBAL_PREFIX);

  if (deleteUsageError) {
    console.error('Failed to clear storage_usage:', deleteUsageError);
  }

  // グローバル使用量を0にリセット
  const { error: resetGlobalError } = await supabase
    .from('storage_usage')
    .upsert({
      user_prefix: GLOBAL_PREFIX,
      bytes_used: 0,
      blob_count: 0,
      updated_at: new Date().toISOString(),
    });

  if (resetGlobalError) {
    console.error('Failed to reset global usage:', resetGlobalError);
  }

  console.log('✅ Existing records cleared\n');

  // Vercel Blobからファイル一覧を取得
  console.log('📋 Fetching Vercel Blob files...');

  let cursor;
  let totalFiles = 0;
  let totalBytes = 0;
  const userUsage = new Map(); // ユーザーごとの使用量を集計

  try {
    do {
      const response = await list({ cursor, limit: 1000 });

      for (const blob of response.blobs) {
        totalFiles++;
        totalBytes += blob.size;

        const userPrefix = extractUserPrefixFromPathname(blob.pathname) || 'unknown_';

        // ユーザーごとの使用量を集計
        if (!userUsage.has(userPrefix)) {
          userUsage.set(userPrefix, { bytes: 0, count: 0 });
        }
        const usage = userUsage.get(userPrefix);
        usage.bytes += blob.size;
        usage.count++;

        // blob_files テーブルに記録
        const { error: insertError } = await supabase
          .from('blob_files')
          .insert({
            url: blob.url,
            user_prefix: userPrefix,
            file_size: blob.size,
            storage_type: 'vercel',
            created_at: blob.uploadedAt || new Date().toISOString(),
          });

        if (insertError) {
          console.warn(`  ⚠️  Failed to insert: ${blob.pathname}`, insertError.message);
        } else {
          console.log(`  ✅ Recorded: ${blob.pathname} (${blob.size} bytes, user: ${userPrefix})`);
        }
      }

      cursor = response.cursor;
    } while (cursor);

    console.log(`\n📊 Found ${totalFiles} files (${formatBytes(totalBytes)} total)\n`);

    // 各ユーザーの使用量をDBに反映
    console.log('📝 Updating storage usage records...');

    for (const [userPrefix, usage] of userUsage) {
      await updateStorageUsage(supabase, userPrefix, usage.bytes, usage.count);
      console.log(`  ✅ ${userPrefix}: ${formatBytes(usage.bytes)} (${usage.count} files)`);
    }

    console.log('\n✅ Storage usage initialization complete!\n');

    // サマリーを表示
    console.log('📊 Summary:');
    console.log(`   Total files: ${totalFiles}`);
    console.log(`   Total size: ${formatBytes(totalBytes)}`);
    console.log(`   Unique users: ${userUsage.size}`);

  } catch (error) {
    console.error('\n❌ Error during initialization:', error);
    process.exit(1);
  }
}

/**
 * バイトを人間が読める形式にフォーマット
 * @param {number} bytes - バイト数
 * @returns {string} フォーマットされた文字列
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 実行
initializeStorageUsage().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
