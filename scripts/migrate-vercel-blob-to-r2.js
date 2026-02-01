#!/usr/bin/env node

/**
 * Vercel Blob to R2 Migration Script
 * Vercel BlobからR2への移行スクリプト
 *
 * このスクリプトは以下を実行します：
 * 1. DBからVercel Blob URLを持つカードを取得
 * 2. 各ファイルをVercel Blobからダウンロード
 * 3. R2にアップロード
 * 4. DBのURLを更新
 * 5. blob_filesテーブルを更新
 * 6. （オプション）Vercel Blobから削除
 *
 * 実行方法:
 *   # ドライラン（実際の変更なし）
 *   node scripts/migrate-vercel-blob-to-r2.js --dry-run
 *
 *   # 実行（Vercel Blobは削除しない）
 *   node scripts/migrate-vercel-blob-to-r2.js
 *
 *   # 実行（Vercel Blobも削除）
 *   node scripts/migrate-vercel-blob-to-r2.js --delete-source
 *
 * 必要な環境変数:
 *   - NEXT_PUBLIC_SUPABASE_URL: SupabaseのURL
 *   - SUPABASE_SERVICE_ROLE_KEY: Supabaseのサービスロールキー
 *   - R2_ENDPOINT: R2エンドポイント
 *   - R2_ACCESS_KEY_ID: R2アクセスキーID
 *   - R2_SECRET_ACCESS_KEY: R2シークレットアクセスキー
 *   - R2_BUCKET_NAME: R2バケット名
 *   - R2_PUBLIC_URL: R2パブリックURL
 *   - BLOB_READ_WRITE_TOKEN: Vercel Blobトークン（--delete-source使用時のみ必要）
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
// 移行スクリプト専用のenvファイルを使用（.env.local はNext.jsビルド時に読み込まれるため避ける）
require('dotenv').config({ path: '.env.migration' });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createClient } = require('@supabase/supabase-js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// コマンドライン引数の解析
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DELETE_SOURCE = args.includes('--delete-source');

// Vercel Blob削除用（動的インポート - 必要時のみ）
let vercelBlobDel = null;

/**
 * Supabase クライアントの初期化
 */
function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables');
  }

  return createClient(url, key);
}

/**
 * R2クライアントの初期化
 */
function getR2Client() {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2 environment variables: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }

  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

/**
 * URLがVercel BlobのURLかどうかを判定
 */
function isVercelBlobUrl(url) {
  if (!url) return false;
  return url.includes('blob.vercel-storage.com') ||
         url.includes('public.blob.vercel-storage.com');
}

/**
 * URLからファイル名を抽出
 */
function extractFileNameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    return pathname.split('/').pop();
  } catch {
    return null;
  }
}

/**
 * Content-TypeをURLから推測
 */
function guessContentType(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * ファイルをダウンロード
 */
async function downloadFile(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * R2にアップロード
 */
async function uploadToR2(r2Client, fileName, buffer, contentType) {
  const bucket = process.env.R2_BUCKET_NAME;
  const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, '');

  if (!bucket || !publicUrl) {
    throw new Error('Missing R2_BUCKET_NAME or R2_PUBLIC_URL');
  }

  await r2Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: fileName,
    Body: buffer,
    ContentType: contentType,
  }));

  return `${publicUrl}/${fileName}`;
}

/**
 * メイン処理
 */
async function migrateVercelBlobToR2() {
  console.log('🚀 Vercel Blob to R2 Migration Script');
  console.log('=====================================\n');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No changes will be made\n');
  }

  if (DELETE_SOURCE) {
    console.log('⚠️  DELETE SOURCE MODE - Files will be deleted from Vercel Blob after migration\n');
    // 動的にVercel Blobをインポート
    try {
      const vercelBlob = await import('@vercel/blob');
      vercelBlobDel = vercelBlob.del;
    } catch (e) {
      console.error('❌ Failed to import @vercel/blob. Install it with: npm install @vercel/blob');
      process.exit(1);
    }
  }

  const supabase = getSupabaseAdmin();
  const r2Client = getR2Client();

  // Vercel Blob URLを持つカードを取得
  console.log('📋 Fetching cards with Vercel Blob URLs...\n');

  const { data: cards, error: cardsError } = await supabase
    .from('cards')
    .select('id, name, image_url, streamer_id')
    .or('image_url.ilike.%blob.vercel-storage.com%,image_url.ilike.%public.blob.vercel-storage.com%');

  if (cardsError) {
    console.error('❌ Failed to fetch cards:', cardsError);
    process.exit(1);
  }

  if (!cards || cards.length === 0) {
    console.log('✅ No cards with Vercel Blob URLs found. Migration complete!\n');
    return;
  }

  console.log(`📊 Found ${cards.length} cards with Vercel Blob URLs\n`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const card of cards) {
    const { id, name, image_url } = card;
    console.log(`\n📄 Processing card: ${name} (ID: ${id})`);
    console.log(`   Source: ${image_url}`);

    if (!isVercelBlobUrl(image_url)) {
      console.log('   ⏭️  Skipped: Not a Vercel Blob URL');
      skipCount++;
      continue;
    }

    const fileName = extractFileNameFromUrl(image_url);
    if (!fileName) {
      console.log('   ⚠️  Skipped: Could not extract filename');
      skipCount++;
      continue;
    }

    const contentType = guessContentType(fileName);

    if (DRY_RUN) {
      console.log(`   🔍 Would migrate: ${fileName} (${contentType})`);
      successCount++;
      continue;
    }

    try {
      // ファイルをダウンロード
      console.log(`   ⬇️  Downloading...`);
      const buffer = await downloadFile(image_url);
      console.log(`   ✅ Downloaded: ${buffer.length} bytes`);

      // R2にアップロード
      console.log(`   ⬆️  Uploading to R2...`);
      const newUrl = await uploadToR2(r2Client, fileName, buffer, contentType);
      console.log(`   ✅ Uploaded: ${newUrl}`);

      // DBのカードを更新
      console.log(`   💾 Updating database...`);
      const { error: updateError } = await supabase
        .from('cards')
        .update({ image_url: newUrl })
        .eq('id', id);

      if (updateError) {
        throw new Error(`DB update failed: ${updateError.message}`);
      }

      // blob_filesテーブルを更新（存在する場合）
      // 古いURLのレコードを削除し、新しいURLでレコードを作成
      const { error: deleteOldError } = await supabase
        .from('blob_files')
        .delete()
        .eq('url', image_url);

      if (deleteOldError && !deleteOldError.message.includes('does not exist')) {
        console.log(`   ⚠️  Warning: Could not delete old blob_files record: ${deleteOldError.message}`);
      }

      // 新しいレコードを挿入
      // ユーザープレフィックスを抽出
      const userPrefix = fileName.split('_')[0];
      const { error: insertError } = await supabase
        .from('blob_files')
        .upsert({
          url: newUrl,
          user_prefix: userPrefix?.length === 8 ? userPrefix : 'unknown_',
          file_size: buffer.length,
          storage_type: 'r2',
          created_at: new Date().toISOString(),
        }, { onConflict: 'url' });

      if (insertError && !insertError.message.includes('does not exist')) {
        console.log(`   ⚠️  Warning: Could not insert blob_files record: ${insertError.message}`);
      }

      // storage_usageの更新はRPCで行う（存在する場合）
      // Vercel側の使用量を減算、R2側は挿入時に自動加算される想定

      console.log(`   ✅ Database updated`);

      // ソースを削除（オプション）
      if (DELETE_SOURCE && vercelBlobDel) {
        console.log(`   🗑️  Deleting from Vercel Blob...`);
        try {
          await vercelBlobDel(image_url);
          console.log(`   ✅ Deleted from Vercel Blob`);
        } catch (delError) {
          console.log(`   ⚠️  Warning: Could not delete from Vercel Blob: ${delError.message}`);
        }
      }

      successCount++;
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      errorCount++;
    }
  }

  // サマリー
  console.log('\n=====================================');
  console.log('📊 Migration Summary');
  console.log('=====================================');
  console.log(`   Total cards: ${cards.length}`);
  console.log(`   ✅ Success: ${successCount}`);
  console.log(`   ⏭️  Skipped: ${skipCount}`);
  console.log(`   ❌ Errors: ${errorCount}`);

  if (DRY_RUN) {
    console.log('\n⚠️  This was a dry run. No changes were made.');
    console.log('   Run without --dry-run to perform the migration.');
  } else if (DELETE_SOURCE) {
    console.log('\n✅ Migration complete. Files have been deleted from Vercel Blob.');
  } else {
    console.log('\n✅ Migration complete. Original files remain in Vercel Blob.');
    console.log('   Run with --delete-source to delete them after verifying migration.');
  }
}

// 実行
migrateVercelBlobToR2().catch((error) => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
