# TwiCa - E2Eテストケース

## テスト環境
- 本番URL: https://twica.bluemoon.works/
- ツール: agent-browser
- 対象: 公開ページとログイン必要なページ（認証状態を使用）

---

## 1. 公開ページのテスト

### TC-001: トップページの表示と基本要素の確認
**目的:** トップページが正しく表示され、主要要素が存在することを確認する

**前提条件:**
- ブラウザが起動している
- ネットワーク接続がある

**テストステップ:**
1. `agent-browser open https://twica.bluemoon.works/` を実行
2. `agent-browser snapshot -i` でインタラクティブ要素を確認
3. `agent-browser snapshot` で完全なページ構造を確認
4. `agent-browser screenshot /tmp/tc001-homepage.png` でスクリーンショットを取得

**期待結果:**
- ページタイトルが "TwiCa - Twitch Channel Point Trading Cards" である
- 開発初期段階の警告メッセージが表示される
- ヘッダーに "TwiCa" というタイトルがある
- メインエリアに "チャネルポイントでカードをゲット" という見出しがある
- サービス説明文が表示される
- "Twitchでログイン" ボタンが2つ存在する（ref=e1, ref=e2）
- 3つの機能紹介セクションが表示される：
  - 🎴 カードを集めよう
  - ✨ レアカードを狙え
  - 📺 配信を盛り上げ
- 配信者向けセクションが表示される
- フッターに利用規約リンク（ref=e3）がある
- コピーライト表記 "© 2025 TwiCa. All rights reserved." がある

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser get title
agent-browser screenshot /tmp/tc001-homepage.png
```

---

### TC-002: ヘッダーのTwitchログインボタン確認
**目的:** ヘッダーのログインボタンが機能することを確認する

**前提条件:**
- TC-001が成功している
- トップページが表示されている

**テストステップ:**
1. `agent-browser snapshot -i` でボタンのrefを確認
2. ヘッダーの "Twitchでログイン" ボタン（ref=e1）の存在を確認
3. `agent-browser get text @e1` でボタンテキストを確認

**期待結果:**
- ボタンに "Twitchでログイン" というテキストが表示される
- ボタンがクリック可能である

**注意:**
- 本番環境では実際のログインテストは実行しない（認証が必要）

**実装例:**
```bash
agent-browser snapshot -i
agent-browser get text @e1
```

---

### TC-003: メインエリアのログインボタン確認
**目的:** メインエリアのログインボタンが適切に表示されることを確認する

**前提条件:**
- TC-001が成功している

**テストステップ:**
1. `agent-browser snapshot -i` で要素を確認
2. メインエリアの "Twitchでログイン" ボタン（ref=e2, nth=1）を確認
3. ボタン内の画像要素を確認

**期待結果:**
- ボタンに "Twitchでログイン" というテキストとアイコン画像が含まれる
- ボタンがクリック可能である

**実装例:**
```bash
agent-browser snapshot -i
agent-browser get text @e2
```

---

### TC-004: 利用規約リンクの動作確認
**目的:** 利用規約ページへのナビゲーションが機能することを確認する

**前提条件:**
- トップページが表示されている

**テストステップ:**
1. トップページで利用規約リンク（ref=e3）をクリック
2. `agent-browser click @e3` を実行
3. `agent-browser wait --load networkidle` でページ読み込み完了を待つ
4. `agent-browser get url` でURLを確認
5. `agent-browser get title` でページタイトルを確認
6. `agent-browser snapshot` でページ内容を確認
7. `agent-browser screenshot /tmp/tc004-tos-page.png` でスクリーンショットを取得

**期待結果:**
- URLが `https://twica.bluemoon.works/tos` である
- ページタイトルが "利用規約 - TwiCa" である
- "利用規約" という見出しが表示される
- 以下のセクションが含まれる：
  - 第1条 サービスの概要
  - 第2条 ユーザーの責任と義務
  - 第3条 利用制限
  - 第4条 知的財産権
  - 第5条 免責事項
  - 第6条 変更と終了
  - 第7条 お問い合わせ先
- お問い合わせ先メールアドレスが表示される
- 最終更新日が表示される
- "ホーム" リンクがある

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser get url
agent-browser get title
agent-browser snapshot
agent-browser screenshot /tmp/tc004-tos-page.png
```

---

### TC-005: 利用規約ページから戻る
**目的:** 利用規約ページからトップページに戻れることを確認する

**前提条件:**
- TC-004が成功している
- 利用規約ページが表示されている

**テストステップ:**
1. `agent-browser snapshot -i` でナビゲーション要素を確認
2. "TwiCa" ロゴリンク（ref=e1）または "ホーム" リンク（ref=e10）をクリック
3. `agent-browser wait --load networkidle` でページ読み込みを待つ
4. `agent-browser get url` でURLを確認
5. `agent-browser get title` でページタイトルを確認

**期待結果:**
- URLが `https://twica.bluemoon.works/` である
- ページタイトルが "TwiCa - Twitch Channel Point Trading Cards" である
- トップページの主要要素が表示される

**実装例:**
```bash
agent-browser snapshot -i
agent-browser click @e1
agent-browser wait --load networkidle
agent-browser get url
agent-browser get title
```

---

### TC-006: ページレスポンシブデザインの確認
**目的:** ページが異なる画面サイズで適切に表示されることを確認する

**前提条件:**
- ブラウザが起動している

**テストステップ:**
1. デスクトップサイズでトップページを開く
2. `agent-browser screenshot /tmp/tc006-desktop.png` でスクリーンショット取得
3. モバイルサイズでスクリーンショット取得（agent-browserがビューポート設定をサポートしている場合）

**期待結果:**
- デスクトップとモバイルの両方で主要要素が表示される
- レイアウトが崩れていない
- テキストが読める
- ボタンがクリック可能なサイズである

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser wait --load networkidle
agent-browser screenshot --full /tmp/tc006-desktop-full.png
```

---

## 2. アクセシビリティテスト

### TC-101: インタラクティブ要素のアクセシビリティ
**目的:** すべてのインタラクティブ要素に適切な役割とラベルがあることを確認する

**前提条件:**
- トップページが表示されている

**テストステップ:**
1. `agent-browser snapshot -i` でインタラクティブ要素を取得
2. 各要素のrole（button、link等）を確認
3. 各要素のラベルテキストを確認

**期待結果:**
- すべてのボタンに "button" ロールがある
- すべてのリンクに "link" ロールがある
- すべての要素に説明的なラベルまたはテキストがある
- ref属性によって要素が一意に識別できる

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser snapshot -i
```

---

### TC-102: ページ構造のセマンティック確認
**目的:** ページが適切なセマンティックHTML構造を持つことを確認する

**前提条件:**
- トップページが表示されている

**テストステップ:**
1. `agent-browser snapshot` で完全なアクセシビリティツリーを取得
2. ランドマーク要素（banner、main、contentinfo）の存在を確認
3. 見出し階層（h1、h2、h3）を確認

**期待結果:**
- document内にbanner、main、contentinfoが存在する
- h1見出しが1つ存在する（"TwiCa"）
- h2見出しが適切に使用されている（"チャネルポイントでカードをゲット"）
- h3見出しが機能説明に使用されている
- 見出し階層が論理的である

**実装例:**
```bash
agent-browser snapshot
```

---

## 3. エラーハンドリングとエッジケースのテスト

### TC-201: 存在しないページへのアクセス
**目的:** 404エラーが適切に処理されることを確認する

**前提条件:**
- ブラウザが起動している

**テストステップ:**
1. `agent-browser open https://twica.bluemoon.works/nonexistent-page` を実行
2. `agent-browser wait --load networkidle` でページ読み込みを待つ
3. `agent-browser get title` でページタイトルを確認
4. `agent-browser snapshot` でページ内容を確認
5. `agent-browser screenshot /tmp/tc201-404.png` でスクリーンショット取得

**期待結果:**
- 404エラーページまたはNext.jsのデフォルトエラーページが表示される
- エラーメッセージが表示される
- ホームページへのリンクがある（可能であれば）

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/nonexistent-page
agent-browser wait --load networkidle
agent-browser get title
agent-browser snapshot
agent-browser screenshot /tmp/tc201-404.png
```

---

### TC-202: ネットワーク遅延時の動作
**目的:** ページが低速ネットワークでも正しく読み込まれることを確認する

**前提条件:**
- ブラウザが起動している

**テストステップ:**
1. `agent-browser open https://twica.bluemoon.works/` を実行
2. `agent-browser wait --load networkidle` で完全な読み込みを待つ（タイムアウト設定長め）
3. `agent-browser snapshot -i` で要素を確認

**期待結果:**
- ページが最終的に完全に読み込まれる
- すべての主要要素が表示される
- JavaScriptエラーが発生しない

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser wait 5000
agent-browser wait --load networkidle
agent-browser snapshot -i
```

---

### TC-203: JavaScriptエラーの確認
**目的:** ページにJavaScriptエラーがないことを確認する

**前提条件:**
- トップページが表示されている

**テストステップ:**
1. トップページを開く
2. `agent-browser console` でコンソールメッセージを確認
3. `agent-browser errors` でページエラーを確認

**期待結果:**
- コンソールに重大なエラーがない
- ページエラーが報告されない
- 警告メッセージのみの場合は許容される

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser wait --load networkidle
agent-browser console
agent-browser errors
```

---

## 4. パフォーマンステスト

### TC-301: ページ読み込み時間の確認
**目的:** ページが合理的な時間内に読み込まれることを確認する

**前提条件:**
- ブラウザが起動している

**テストステップ:**
1. `agent-browser open https://twica.bluemoon.works/` を実行（時間計測開始）
2. `agent-browser wait --load networkidle` でページ読み込み完了を待つ
3. 読み込み時間を記録

**期待結果:**
- ページが10秒以内に読み込まれる（ネットワーク環境による）
- networkidleイベントが発生する
- ページが完全にインタラクティブになる

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser wait --load networkidle
```

---

### TC-302: 画像の読み込み確認
**目的:** すべての画像が正しく読み込まれることを確認する

**前提条件:**
- トップページが表示されている

**テストステップ:**
1. トップページを開く
2. `agent-browser wait --load networkidle` で完全読み込みを待つ
3. `agent-browser screenshot --full /tmp/tc302-images.png` でスクリーンショット取得
4. スクリーンショットで画像の読み込みを視覚的に確認

**期待結果:**
- Twitchログインボタンのアイコン画像が表示される
- 画像の代替テキストが適切に設定されている
- 壊れた画像リンクがない

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser wait --load networkidle
agent-browser screenshot --full /tmp/tc302-images.png
```

---

## 5. クロスブラウザ・クロスプラットフォームテスト

### TC-401: 複数ブラウザでの表示確認
**目的:** 異なるブラウザで一貫した表示がされることを確認する

**前提条件:**
- 複数のブラウザ環境がある（agent-browserのセッション機能を利用）

**テストステップ:**
1. `agent-browser --session chrome open https://twica.bluemoon.works/` を実行
2. Chromeセッションでスクリーンショット取得
3. 必要に応じて他のブラウザでも同様に実行

**期待結果:**
- すべてのブラウザで主要要素が表示される
- レイアウトの大きな違いがない
- すべての機能が動作する

**実装例:**
```bash
agent-browser --session test1 open https://twica.bluemoon.works/
agent-browser --session test1 wait --load networkidle
agent-browser --session test1 screenshot /tmp/tc401-browser1.png
```

---

## 6. ログインフロー関連テスト（制限付き）

### TC-501: ログインボタンのクリックとリダイレクト確認
**目的:** ログインボタンをクリックするとTwitch認証ページにリダイレクトされることを確認する

**前提条件:**
- トップページが表示されている

**テストステップ:**
1. `agent-browser snapshot -i` でログインボタンを確認
2. `agent-browser click @e1` でヘッダーのログインボタンをクリック
3. `agent-browser wait --load networkidle` でページ遷移を待つ
4. `agent-browser get url` で遷移先URLを確認

**期待結果:**
- URLが `/api/auth/twitch/login` またはTwitch認証ページにリダイレクトされる
- エラーが発生しない

**注意:**
- 実際のログイン処理は実行しない
- リダイレクト先のURLを確認するだけで、戻る操作を実行する

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser snapshot -i
agent-browser click @e1
agent-browser wait 2000
agent-browser get url
agent-browser back
```

---

## 7. セキュリティテスト（基本）

### TC-601: HTTPS接続の確認
**目的:** サイトがHTTPS経由で提供されることを確認する

**前提条件:**
- ブラウザが起動している

**テストステップ:**
1. `agent-browser open https://twica.bluemoon.works/` を実行
2. `agent-browser get url` でURLを確認

**期待結果:**
- URLが `https://` で始まる
- HTTP接続が自動的にHTTPSにリダイレクトされる（該当する場合）

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/
agent-browser get url
```

---

### TC-602: CSPヘッダーの存在確認
**目的:** セキュリティヘッダーが適切に設定されていることを確認する

**前提条件:**
- ブラウザ開発者ツールまたはネットワーク監視ツールが利用可能

**テストステップ:**
1. ブラウザの開発者ツールでネットワークタブを開く
2. トップページにアクセス
3. レスポンスヘッダーを確認

**期待結果:**
- 適切なセキュリティヘッダーが設定されている
  - Content-Security-Policy
  - X-Frame-Options
  - X-Content-Type-Options

**注意:**
- agent-browserがレスポンスヘッダーの取得をサポートしていない場合は手動確認

---

## 8. OBSオーバーレイのテスト（公開URL）

### TC-701: オーバーレイページへのアクセス
**目的:** オーバーレイページが正しく表示されることを確認する

**前提条件:**
- 有効なstreamerIdがある（テスト用または既知の配信者ID）

**テストステップ:**
1. `agent-browser open https://twica.bluemoon.works/overlay/{streamerId}` を実行
2. `agent-browser wait --load networkidle` でページ読み込みを待つ
3. `agent-browser snapshot` でページ構造を確認
4. `agent-browser screenshot /tmp/tc701-overlay.png` でスクリーンショット取得

**期待結果:**
- ページが透明な背景で表示される
- 接続状態インジケーターが表示される
- "Demo" ボタンが表示される（右下）
- エラーが発生しない

**注意:**
- 実際のstreamerIdを使用する場合、事前に確認が必要
- デモモードでのテストも検討

**実装例:**
```bash
# テスト用のstreamerIdを使用
agent-browser open "https://twica.bluemoon.works/overlay/test-streamer-id"
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser screenshot /tmp/tc701-overlay.png
```

---

### TC-702: オーバーレイのデモモード確認
**目的:** デモモードでガチャ演出が表示されることを確認する

**前提条件:**
- オーバーレイページが表示されている

**テストステップ:**
1. `agent-browser open "https://twica.bluemoon.works/overlay/{streamerId}?demo=true"` を実行
2. `agent-browser wait 3000` で演出開始を待つ
3. `agent-browser snapshot` でカード表示を確認
4. `agent-browser screenshot /tmp/tc702-demo.png` でスクリーンショット取得

**期待結果:**
- 0.5秒後にデモガチャが自動実行される
- カード情報がアニメーション表示される
- レアリティに応じた色とエフェクトが適用される
- 6秒後にフェードアウトする

**実装例:**
```bash
agent-browser open "https://twica.bluemoon.works/overlay/test-streamer-id?demo=true"
agent-browser wait 1000
agent-browser screenshot /tmp/tc702-demo-1.png
agent-browser wait 3000
agent-browser screenshot /tmp/tc702-demo-2.png
agent-browser wait 3000
agent-browser screenshot /tmp/tc702-demo-3.png
```

---

## 9. 総合シナリオテスト

### TC-801: ユーザージャーニー全体のテスト
**目的:** 典型的なユーザージャーニーが問題なく完了することを確認する

**前提条件:**
- ブラウザが起動している

**テストステップ:**
1. トップページにアクセス
2. サービス説明を確認
3. 利用規約ページに移動
4. 利用規約を確認
5. トップページに戻る
6. ログインボタンの存在を確認（クリックはしない）

**期待結果:**
- すべてのページ遷移がスムーズに動作する
- ページ間のナビゲーションが正常に機能する
- 各ページで主要な情報が表示される
- エラーが発生しない

**実装例:**
```bash
# 1. トップページにアクセス
agent-browser open https://twica.bluemoon.works/
agent-browser wait --load networkidle
agent-browser screenshot /tmp/tc801-step1.png

# 2. サービス説明を確認
agent-browser snapshot
agent-browser get text @e3  # 見出し確認

# 3. 利用規約ページに移動
agent-browser snapshot -i
agent-browser click @e3  # 利用規約リンク
agent-browser wait --load networkidle
agent-browser screenshot /tmp/tc801-step3.png

# 4. 利用規約を確認
agent-browser snapshot

# 5. トップページに戻る
agent-browser click @e1  # ホームリンク
agent-browser wait --load networkidle
agent-browser screenshot /tmp/tc801-step5.png

# 6. ログインボタンの存在を確認
agent-browser snapshot -i
agent-browser get text @e1
```

---

## テスト実行チェックリスト

### 実行前の準備
- [ ] agent-browserがインストールされている
- [ ] ネットワーク接続が安定している
- [ ] スクリーンショット保存用のディレクトリ（/tmp）が利用可能
- [ ] 本番環境（https://twica.bluemoon.works/）が稼働している

### 基本機能テスト
- [ ] TC-001: トップページの表示
- [ ] TC-002: ヘッダーログインボタン
- [ ] TC-003: メインエリアログインボタン
- [ ] TC-004: 利用規約ページ遷移
- [ ] TC-005: 利用規約からの戻り
- [ ] TC-006: レスポンシブデザイン

### アクセシビリティテスト
- [ ] TC-101: インタラクティブ要素
- [ ] TC-102: ページ構造のセマンティック

### エラーハンドリングテスト
- [ ] TC-201: 404エラーページ
- [ ] TC-202: ネットワーク遅延
- [ ] TC-203: JavaScriptエラー

### パフォーマンステスト
- [ ] TC-301: ページ読み込み時間
- [ ] TC-302: 画像読み込み

### ログインフローテスト
- [ ] TC-501: ログインリダイレクト

### セキュリティテスト
- [ ] TC-601: HTTPS接続
- [ ] TC-602: セキュリティヘッダー（手動）

### オーバーレイテスト
- [ ] TC-701: オーバーレイページアクセス
- [ ] TC-702: デモモード

### 総合テスト
- [ ] TC-801: ユーザージャーニー全体

---

## テスト実行ログ形式

各テストケース実行後、以下の形式で結果を記録してください：

```
テストケースID: TC-XXX
実行日時: YYYY-MM-DD HH:MM:SS
実行者: [名前]
結果: PASS / FAIL / SKIP
実行時間: XX秒
備考: [問題点や気づいた点]
スクリーンショット: /tmp/tcXXX-*.png
```

---

## 10. 認証後ページのテスト（本番環境）

**重要:** このセクションのテストケースは本番環境（https://twica.bluemoon.works/）で実行されます。

### 前提条件
- 認証状態ファイルがセットアップ済み：
  - 視聴者用: `.e2e-auth-state-viewer-prod.json`
  - 配信者用: `.e2e-auth-state-streamer-prod.json`
- E2Eテストスキルで `--auth` フラグを使用して実行

### 認証状態のセットアップ方法
```bash
# 初回のみ: 手動ログインで認証状態を保存（本番環境）
/e2e-test --env production --setup-auth viewer
/e2e-test --env production --setup-auth streamer
```

---

### TC-901: ダッシュボード（視聴者）の表示確認
**目的:** 視聴者ユーザーでダッシュボードが正しく表示されることを確認する

**ユーザー種別:** viewer

**前提条件:**
- 認証状態（viewer）がロード済み
- ログイン済み状態

**テストステップ:**
1. `agent-browser state load .e2e-auth-state-viewer-prod.json` で認証状態を復元
2. `agent-browser open https://twica.bluemoon.works/dashboard` を実行
3. `agent-browser wait --load networkidle` でページ読み込みを待つ
4. `agent-browser get title` でページタイトルを確認
5. `agent-browser snapshot -i` でインタラクティブ要素を確認
6. `agent-browser snapshot` で完全なページ構造を確認
7. `agent-browser screenshot /tmp/tc901-dashboard-viewer.png` でスクリーンショット取得

**期待結果:**
- URLが `https://twica.bluemoon.works/dashboard` である
- ページタイトルが "ダッシュボード - TwiCa" である
- ユーザー情報セクションが表示される
- カードコレクションが表示される
- ログインリダイレクトが発生しない
- 視聴者向けの機能が表示される

---

### TC-902: カードバトルページの表示確認
**目的:** 視聴者ユーザーでカードバトルページが正しく表示されることを確認する

**ユーザー種別:** viewer

**前提条件:**
- 認証状態（viewer）がロード済み
- ログイン済み状態

**テストステップ:**
1. `agent-browser state load .e2e-auth-state-viewer-prod.json` で認証状態を復元
2. `agent-browser open https://twica.bluemoon.works/battle` を実行
3. `agent-browser wait --load networkidle` でページ読み込みを待つ
4. `agent-browser get title` でページタイトルを確認
5. `agent-browser snapshot -i` でインタラクティブ要素を確認
6. `agent-browser screenshot /tmp/tc902-battle.png` でスクリーンショット取得

**期待結果:**
- URLが `https://twica.bluemoon.works/battle` である
- ページタイトルが "カードバトル - TwiCa" である
- バトルアリーナが表示される
- デッキが表示される
- バトル関連の機能が利用可能である

---

### TC-903: バトル統計ページの表示確認
**目的:** 視聴者ユーザーでバトル統計ページが正しく表示されることを確認する

**ユーザー種別:** viewer

**前提条件:**
- 認証状態（viewer）がロード済み
- ログイン済み状態

**テストステップ:**
1. `agent-browser state load .e2e-auth-state-viewer-prod.json` で認証状態を復元
2. `agent-browser open https://twica.bluemoon.works/battle/stats` を実行
3. `agent-browser wait --load networkidle` でページ読み込みを待つ
4. `agent-browser get title` でページタイトルを確認
5. `agent-browser snapshot -i` でインタラクティブ要素を確認
6. `agent-browser screenshot /tmp/tc903-battle-stats.png` でスクリーンショット取得

**期待結果:**
- URLが `https://twica.bluemoon.works/battle/stats` である
- ページタイトルが "バトル統計 - TwiCa" である
- 統計表が表示される
- 勝率などの統計情報が表示される

---

### TC-911: ダッシュボード配信者機能の確認
**目的:** 配信者ユーザーでダッシュボードの配信者専用機能が表示されることを確認する

**ユーザー種別:** streamer

**前提条件:**
- 認証状態（streamer）がロード済み
- 配信者権限でログイン済み

**テストステップ:**
1. `agent-browser state load .e2e-auth-state-streamer-prod.json` で認証状態を復元
2. `agent-browser open https://twica.bluemoon.works/dashboard` を実行
3. `agent-browser wait --load networkidle` でページ読み込みを待つ
4. `agent-browser get title` でページタイトルを確認
5. `agent-browser snapshot -i` でインタラクティブ要素を確認
6. `agent-browser screenshot /tmp/tc911-dashboard-streamer.png` でスクリーンショット取得

**期待結果:**
- URLが `https://twica.bluemoon.works/dashboard` である
- ページタイトルが "ダッシュボード - TwiCa" である
- 配信者設定パネルが表示される
- カード管理リンクが表示される
- 配信者専用の機能が利用可能である

---

### TC-912: カード管理ページの確認
**目的:** 配信者ユーザーでカード管理ページが正しく表示されることを確認する

**ユーザー種別:** streamer

**前提条件:**
- 認証状態（streamer）がロード済み
- 配信者権限でログイン済み

**テストステップ:**
1. `agent-browser state load .e2e-auth-state-streamer-prod.json` で認証状態を復元
2. `agent-browser open https://twica.bluemoon.works/dashboard` を実行（カード管理へのナビゲーション経由）
3. `agent-browser wait --load networkidle` でページ読み込みを待つ
4. `agent-browser snapshot -i` でカード管理要素を確認
5. `agent-browser screenshot /tmp/tc912-card-manager.png` でスクリーンショット取得

**期待結果:**
- カード管理機能が表示される
- カードの作成・編集・削除機能が利用可能である
- レアリティ設定が表示される
- カードプレビューが表示される

---

### TC-920: 認証期限切れ時のリダイレクト確認
**目的:** セッション期限切れ時に適切にログインページへリダイレクトされることを確認する

**ユーザー種別:** viewer または streamer

**前提条件:**
- 期限切れの認証状態ファイル、または認証状態なし

**テストステップ:**
1. 期限切れの認証状態をロード（または状態なしで実行）
2. `agent-browser open https://twica.bluemoon.works/dashboard` を実行
3. `agent-browser wait --load networkidle` でページ読み込みを待つ
4. `agent-browser get url` でリダイレクト後のURLを確認

**期待結果:**
- トップページ（`https://twica.bluemoon.works/`）にリダイレクトされる
- またはログインを促すメッセージが表示される
- ダッシュボードのコンテンツは表示されない

---

### 認証テスト実行チェックリスト

#### セットアップ
- [ ] 視聴者用認証状態をセットアップ済み（`/e2e-test --env production --setup-auth viewer`）
- [ ] 配信者用認証状態をセットアップ済み（`/e2e-test --env production --setup-auth streamer`）

#### 視聴者テスト
- [ ] TC-901: ダッシュボード（視聴者）
- [ ] TC-902: カードバトル
- [ ] TC-903: バトル統計

#### 配信者テスト
- [ ] TC-911: ダッシュボード（配信者）
- [ ] TC-912: カード管理

#### エラーケーステスト
- [ ] TC-920: 認証期限切れリダイレクト

---

## 制限事項

本E2Eテストケースは以下の制限があります：

### 本番環境でのテスト
公開ページと認証が必要なページの両方をテストできます。ただし、以下の制約があります：

- 初回セットアップ時に手動ログインが必要（本番環境でのTwitchログイン）
- 認証状態の有効期限は7日間（Twitchセッションの有効期限）
- 期限切れ後は再セットアップが必要（`/e2e-test --env production --setup-auth viewer/streamer`）
- 実際のTwitch APIとの連携が必要な機能は、実際のTwitchアカウントが必要
- ガチャ実行にはチャネルポイントが必要

### テスト対象の機能
以下の機能がテスト可能です：

- 公開ページ（トップページ、利用規約など）
- ログイン後のダッシュボード（視聴者・配信者）
- カードバトル機能
- カード管理機能（配信者のみ）
- OBSオーバーレイ
