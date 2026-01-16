#!/usr/bin/env node

/**
 * セッションクッキー取得ヘルパー
 * 
 * このスクリプトは、画像アップロードテスト用に有効なセッションクッキーを取得する方法をガイドします。
 */

import http from 'http';

console.log(`
============================================================
  画像アップロードテスト用セッションクッキー取得ガイド
============================================================

手順:
============================================================

1. ブラウザで以下のURLにアクセスして、Twitchアカウントで認証してください:
   http://localhost:3000/api/auth/twitch/login

2. 認証が成功すると、ダッシュボードにリダイレクトされます。

3. ブラウザの開発者ツール（F12）を開き、「Application」タブ（または「ストレージ」タブ）を開きます。

4. 左側のメニューから「Cookies」→「http://localhost:3000」を選択します。

5. 「twica_session」という名前のクッキーを探し、その「Value」をコピーしてください。

6. 取得したクッキー値を環境変数として設定するか、
   tests/api/upload.test.js の SESSION_COOKIE_PLACEHOLDER に設定してください。

例（環境変数を使用する場合）:
   TEST_SESSION_COOKIE='{"twitchUserId":"123","twitchUsername":"test",...}' node tests/api/upload.test.js

例（ファイルに直接設定する場合）:
   SESSION_COOKIE_PLACEHOLDER = '{"twitchUserId":"123","twitchUsername":"test",...}'

============================================================
セッション情報の確認
============================================================

認証後に以下のURLにアクセスすると、現在のセッション情報を確認できます:
   http://localhost:3000/api/debug-session

============================================================
注意点
============================================================

- セッションクッキーにはアクセストークンが含まれているため、共有しないでください
- セッションクッキーは30日間有効です
- テスト環境でのみ使用してください

============================================================
`);

// オプション: サーバーが稼働しているか確認
const checkServer = () => {
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/debug-session',
    method: 'GET',
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.authenticated) {
          console.log('\n✓ サーバーは稼働しています');
          console.log(`  ユーザーID: ${json.session?.twitchUserId || 'N/A'}`);
          console.log(`  ユーザー名: ${json.session?.twitchUsername || 'N/A'}`);
          console.log('\nヒント: すでに認証済みのようです。ブラウザで http://localhost:3000/api/debug-session にアクセスして、Cookieを確認してください。');
        } else {
          console.log('\n✓ サーバーは稼働しています');
          console.log('  まだ認証されていません。上記の手順に従って認証してください。');
        }
      } catch {
        console.log('\n✓ サーバーは稼働しています');
      }
    });
  });

  req.on('error', () => {
    console.log('\n✗ サーバーに接続できません');
    console.log('  「npm run dev」コマンドで開発サーバーを起動してください。');
  });

  req.setTimeout(5000, () => {
    console.log('\n✗ サーバーへの接続がタイムアウトしました');
    console.log('  「npm run dev」コマンドで開発サーバーを起動してください。');
    req.destroy();
  });

  req.end();
};

checkServer();
