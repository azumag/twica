# 支援者向け問い合わせフォーム E2Eテストシナリオ

## 対象機能

- 問い合わせページ (`/dashboard/inquiries`)
- 問い合わせの新規投稿
- 問い合わせ一覧の表示
- 問い合わせスレッド詳細 (`/dashboard/inquiries/[id]`)
- 返信投稿

---

## 前提条件

問い合わせページは助力・ご贔屓・Twitchサブスクのいずれかの支援者のみ利用可能。素地のユーザーはアクセス制限メッセージが表示される。

---

## 1. アクセス制御

### TC-1401: 素地ユーザーのアクセス制限

**目的:** 素地のユーザーが問い合わせページにアクセスした際に、制限メッセージが表示されることを確認する

**前提条件:**
- ログイン済みの認証状態（素地のユーザー）

**テストステップ:**
1. 認証状態をロードする
2. `https://twica.bluemoon.works/dashboard/inquiries` を開く
3. ページの内容を確認

**期待結果:**
- 問い合わせフォームは表示されない
- 「この機能は助力/ご贔屓限定です。」等のメッセージが表示される
- エラーページ（500・403等）にはならない（ページ自体は正常に表示される）
- ダッシュボードナビゲーションは引き続き表示される

**実装例:**
```bash
agent-browser state load .e2e-auth-state-viewer-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/inquiries
agent-browser wait --load networkidle
agent-browser snapshot
agent-browser screenshot /tmp/tc1401-basic-restricted.png
```

---

### TC-1402: 未ログインユーザーのアクセス

**目的:** 未ログインユーザーが問い合わせページにアクセスした際に、適切にリダイレクトされることを確認する

**前提条件:** 未ログイン状態（認証状態ロードなし）

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/inquiries` を開く
2. リダイレクト先URLを確認

**期待結果:**
- トップページ (`/`) または `/dashboard` へリダイレクトされる
- 問い合わせページのコンテンツは表示されない

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/dashboard/inquiries
agent-browser wait --load networkidle
agent-browser get url
# → https://twica.bluemoon.works/ へリダイレクトされていることを確認
```

---

## 2. 問い合わせページの表示（支援者）

### TC-1411: 支援者の問い合わせページ表示

**目的:** 支援者（助力以上）が問い合わせページを正常に表示できることを確認する

**前提条件:**
- ログイン済みの認証状態（助力/ご贔屓/Twitchサブスクのユーザー）

**テストステップ:**
1. 支援者の認証状態をロードする
2. `https://twica.bluemoon.works/dashboard/inquiries` を開く
3. スナップショットで要素を確認
4. スクリーンショットを取得

**期待結果:**
- ページタイトル「お問い合わせ」が表示される
- 説明文「バグ報告や機能要望など、お気軽にお問い合わせください。」が表示される
- 新規問い合わせフォームが表示される（またはフォーム表示ボタンが表示される）
- 問い合わせ一覧エリアが表示される
  - 問い合わせがない場合: 「お問い合わせはまだありません。」が表示される
  - 問い合わせがある場合: 問い合わせカードの一覧が表示される

**実装例:**
```bash
agent-browser state load .e2e-auth-state-supporter-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/inquiries
agent-browser wait --load networkidle
agent-browser snapshot
agent-browser screenshot /tmp/tc1411-inquiries-page.png
```

---

## 3. 問い合わせの投稿

### TC-1412: 新規問い合わせの正常投稿

**目的:** 必要項目を入力して問い合わせを正常に投稿できることを確認する

**前提条件:**
- ログイン済みの認証状態（支援者）

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/inquiries` を開く
2. カテゴリを「バグ報告」に設定
3. 件名に「テスト問い合わせ」を入力
4. 本文に「これはE2Eテストから送信された問い合わせです。」を入力
5. 「送信」ボタンをクリック
6. 成功メッセージを確認
7. 問い合わせ一覧に反映されていることを確認

**テストデータ:**
- カテゴリ: バグ報告
- 件名: `[E2E Test] テスト問い合わせ`（最大200文字）
- 本文: `これはE2Eテストから自動送信された問い合わせです。対応不要です。`（最大2000文字）

**期待結果:**
- 「お問い合わせを送信しました」メッセージが表示される
- フォームがリセットされる（またはフォームが閉じる）
- 問い合わせ一覧に投稿した内容が表示される
  - カテゴリバッジ（赤色「バグ報告」）が表示される
  - ステータスバッジ「未対応」（黄色）が表示される
  - 件名が表示される
  - 投稿日時が表示される

**実装例:**
```bash
agent-browser state load .e2e-auth-state-supporter-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/inquiries
agent-browser wait --load networkidle
agent-browser snapshot -i

# カテゴリ選択
agent-browser select @eN "bug"  # NはカテゴリセレクトのRef番号

# 件名入力
agent-browser fill @eM "[E2E Test] テスト問い合わせ"  # M は件名inputのRef番号

# 本文入力
agent-browser fill @eP "これはE2Eテストから自動送信された問い合わせです。対応不要です。"

# 送信
agent-browser click @eQ  # Q は送信ボタンのRef番号
agent-browser wait 3000
agent-browser snapshot
agent-browser screenshot /tmp/tc1412-inquiry-submitted.png
```

---

### TC-1413: バリデーションエラーの表示

**目的:** 必須項目が空の場合にバリデーションエラーが表示されることを確認する

**前提条件:**
- ログイン済みの認証状態（支援者）

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/inquiries` を開く
2. 件名・本文を空のまま「送信」ボタンをクリック
3. バリデーションの結果を確認

**期待結果:**
- 件名が空の場合、送信ボタンがdisabled状態またはエラーメッセージが表示される
- 本文が空の場合も同様
- フォームが送信されない（ページ遷移しない）

---

### TC-1414: 本文・件名の文字数上限確認

**目的:** 文字数上限（件名200文字・本文2000文字）が正しく機能することを確認する

**前提条件:**
- ログイン済みの認証状態（支援者）

**テストステップ:**
1. 件名フィールドに200文字を超えるテキストを入力
2. 実際に入力された文字数を確認（`maxLength`属性で制限される）
3. 本文フィールドに2000文字を超えるテキストを入力
4. 実際に入力された文字数を確認

**期待結果:**
- 件名は最大200文字で切り捨てられる（入力制限）
- 本文は最大2000文字で切り捨てられる（入力制限）

---

## 4. 問い合わせ一覧

### TC-1421: 問い合わせ一覧のカード表示

**目的:** 複数の問い合わせがある場合に一覧が正しく表示されることを確認する

**前提条件:**
- ログイン済みの認証状態（問い合わせが存在する支援者）

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/inquiries` を開く
2. 問い合わせ一覧を確認

**期待結果:**
- 各問い合わせカードに以下が表示される：
  - カテゴリバッジ（バグ報告=赤、機能要望=紫、その他=グレー）
  - ステータスバッジ（未対応=黄、対応中=青、解決済み=緑、クローズ=グレー）
  - 件名（最大1行、長い場合は省略）
  - 本文冒頭（最大1行、長い場合は省略）
  - 投稿日時
- 問い合わせカードはクリック可能（詳細ページへのリンク）
- 新しい問い合わせが上に表示される

**実装例:**
```bash
agent-browser state load .e2e-auth-state-supporter-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/inquiries
agent-browser wait --load networkidle
agent-browser snapshot
agent-browser screenshot /tmp/tc1421-inquiry-list.png
```

---

## 5. 問い合わせスレッド詳細

### TC-1431: 問い合わせ詳細ページの表示

**目的:** 問い合わせカードをクリックして詳細ページが表示されることを確認する

**前提条件:**
- ログイン済みの認証状態（支援者）
- 問い合わせが1件以上存在する

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/inquiries` を開く
2. 問い合わせカードをクリック
3. 詳細ページのURLを確認
4. ページの内容を確認

**期待結果:**
- URLが `/dashboard/inquiries/{id}` の形式
- 問い合わせの詳細情報が表示される：
  - カテゴリバッジ
  - ステータスバッジ
  - 件名
  - 投稿者名・投稿日時
  - 本文（全文）
- 「一覧に戻る」リンクが表示される
- メッセージスレッドセクションが表示される
  - 最初の投稿（初回本文）がスレッドの最上部に表示される
  - 管理者からの返信がある場合、「管理者」バッジ付きで表示される

**実装例:**
```bash
agent-browser state load .e2e-auth-state-supporter-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/inquiries
agent-browser wait --load networkidle
agent-browser snapshot -i
# 最初の問い合わせカードをクリック
agent-browser click @eN  # Nは最初の問い合わせカードのref番号
agent-browser wait --load networkidle
agent-browser get url
agent-browser snapshot
agent-browser screenshot /tmp/tc1431-inquiry-detail.png
```

---

### TC-1432: 問い合わせへの返信投稿

**目的:** 問い合わせスレッドにユーザーが返信できることを確認する

**前提条件:**
- ログイン済みの認証状態（支援者）
- オープン（未対応・対応中）の問い合わせが存在する

**テストステップ:**
1. 問い合わせ詳細ページを開く（`/dashboard/inquiries/{id}`）
2. 返信入力フィールドに返信を入力
3. 「返信」ボタンをクリック
4. 成功メッセージと返信の表示を確認

**テストデータ:**
- 返信内容: `[E2E Test] テスト返信です。自動テストから送信されました。`

**期待結果:**
- 「返信を送信しました」等のメッセージが表示される
- スレッドに新しいメッセージが追加される
  - 「あなた」バッジが付いた形で表示される
  - 返信内容が正しく表示される
  - 返信日時が表示される
- 返信入力フィールドがクリアされる

**実装例:**
```bash
agent-browser state load .e2e-auth-state-supporter-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/inquiries
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser click @eN  # 最初の問い合わせカード
agent-browser wait --load networkidle
agent-browser snapshot -i
# 返信テキストエリアに入力
agent-browser fill @eM "[E2E Test] テスト返信です。自動テストから送信されました。"
# 返信ボタンをクリック
agent-browser click @eP
agent-browser wait 3000
agent-browser snapshot
agent-browser screenshot /tmp/tc1432-inquiry-reply.png
```

---

### TC-1433: クローズ済み問い合わせの返信不可

**目的:** ステータスがクローズされた問い合わせには返信できないことを確認する

**前提条件:**
- ログイン済みの認証状態（支援者）
- クローズ（closed）ステータスの問い合わせが存在する

**テストステップ:**
1. クローズ済みの問い合わせ詳細ページを開く
2. 返信フォームの状態を確認

**期待結果:**
- 「この問い合わせはクローズされています。」等のメッセージが表示される
- 返信フォーム（テキストエリア・送信ボタン）が表示されない、またはdisabled状態

---

### TC-1434: 一覧ページへの戻り

**目的:** 詳細ページから一覧ページへ正常に戻れることを確認する

**前提条件:**
- 問い合わせ詳細ページが表示されている

**テストステップ:**
1. 詳細ページの「一覧に戻る」リンクをクリック
2. URLと表示内容を確認

**期待結果:**
- `/dashboard/inquiries` に遷移する
- 問い合わせ一覧が表示される

**実装例:**
```bash
# 詳細ページで「一覧に戻る」をクリック
agent-browser snapshot -i
agent-browser click @eN  # 「一覧に戻る」リンクのref番号
agent-browser wait --load networkidle
agent-browser get url
# → /dashboard/inquiries を確認
```

---

## 6. ナビゲーション確認

### TC-1441: ダッシュボードナビゲーションに問い合わせリンク

**目的:** ダッシュボードのナビゲーションに「問い合わせ」リンクが表示されていることを確認する

**前提条件:** ログイン済みの認証状態

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard` を開く
2. サイドナビゲーションを確認

**期待結果:**
- ナビゲーションに「問い合わせ」（または類似のテキスト）リンクが表示される
- クリックすると `/dashboard/inquiries` に遷移する

**実装例:**
```bash
agent-browser state load .e2e-auth-state-supporter-prod.json
agent-browser open https://twica.bluemoon.works/dashboard
agent-browser wait --load networkidle
agent-browser snapshot -i
agent-browser screenshot /tmp/tc1441-nav-inquiries.png
```

---

## テスト実行ログ形式

```
テストケースID: TC-XXXX
実行日時: YYYY-MM-DD HH:MM:SS
結果: PASS / FAIL / SKIP
備考: [問題点や気づいた点]
スクリーンショット: /tmp/tcXXXX-*.png
```
