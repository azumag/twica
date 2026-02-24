# 支援特典機能 E2Eテストシナリオ

## 対象機能

- 支援特典ページ (`/plans`)
- 支援コードのアクティベーション（アカウント設定）
- 特典の解除
- ストレージ超過時の「支援特典について」リンク
- リリースノートのv1.28.0セクション

---

## 1. 支援特典ページ（公開ページ・ログイン不要）

### TC-1001: 支援特典ページの基本表示

**目的:** `/plans` ページが正しく表示され、主要要素が存在することを確認する

**前提条件:** ブラウザが起動している（ログイン不要）

**テストステップ:**
1. `https://twica.bluemoon.works/plans` を開く
2. ページタイトルを確認
3. スクリーンショットを取得
4. スナップショットで要素を確認

**期待結果:**
- ページタイトルが "支援特典について - TwiCa" である
- 「支援特典について」見出しが表示される
- 「特典一覧」セクションが表示される
- 4つの特典カード（素地・助力・ご贔屓・Twitchサブスク）が表示される
- 「支援コードの取得方法」セクションが表示される
- 「支援コードの有効化方法」セクションが表示される
- ヘッダーに「TwiCa」ロゴがある
- フッターにリリースノートリンクがある

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/plans
agent-browser wait --load networkidle
agent-browser get title
agent-browser screenshot /tmp/tc1001-plans.png
agent-browser snapshot
```

---

### TC-1002: 各特典の表示確認

**目的:** 各特典カードに正確な情報が表示されることを確認する

**前提条件:** TC-1001が成功している

**テストステップ:**
1. `/plans` ページを開く
2. スナップショットで各特典カードの内容を確認

**期待結果:**

| 特典 | ストレージ | 画像最大幅 | ファイルサイズ上限 | その他 |
|---|---|---|---|---|
| 素地 | 10MB（基本） | 800px | 1MB | − |
| 助力 | +250MB | 1920px（Full HD） | 5MB | 問い合わせフォーム |
| ご贔屓 | +500MB | 3840px（4K） | 10MB | 問い合わせフォーム |
| Twitchサブスク | +500MB（ご贔屓同等） | 3840px（4K） | 10MB | 問い合わせフォーム |

- 各特典にバッジ（色付きラベル）が表示される
  - 素地: グレー
  - 助力: ブルー
  - ご贔屓: イエロー
  - Twitchサブスク: パープル
- Twitchサブスク特典に「作者：あずまぐ（@azumagbanjo）の Twitch チャンネルをサブスクで有効」の説明文が表示される

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/plans
agent-browser wait --load networkidle
agent-browser snapshot
```

---

### TC-1003: FANBOXリンクの確認

**目的:** FANBOXへの外部リンクが正しく機能することを確認する

**前提条件:** `/plans` ページが表示されている

**テストステップ:**
1. スナップショットでFANBOXリンクのrefを確認
2. リンクのhref属性を確認（クリックはしない）
3. スクリーンショットでリンクが視覚的に確認できることを確認

**期待結果:**
- 「FANBOX を見る」ボタンが表示される
- リンクが `https://azumag.fanbox.cc/` を指している
- `target="_blank"` と `rel="noopener noreferrer"` が設定されている

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/plans
agent-browser wait --load networkidle
agent-browser snapshot -i
# FANBOXリンクのref確認
agent-browser get attr @eN href  # NはFANBOXリンクのref番号
```

---

### TC-1004: ログイン済みユーザーのアカウント設定リンク

**目的:** ログイン済みの場合にアカウント設定へのリンクが表示されることを確認する

**前提条件:** ログイン済みの認証状態

**テストステップ:**
1. 認証状態をロードする
2. `/plans` ページを開く
3. 「アカウント設定へ」ボタンの存在を確認
4. ボタンのhrefを確認

**期待結果:**
- 「有効化方法」セクションに「アカウント設定へ」ボタンが表示される
- リンクが `/dashboard/account` を指している

**実装例:**
```bash
agent-browser state load .e2e-auth-state-viewer-prod.json
agent-browser open https://twica.bluemoon.works/plans
agent-browser wait --load networkidle
agent-browser snapshot -i
# 「アカウント設定へ」ボタンのref確認・href確認
```

---

### TC-1005: 未ログインユーザーの表示（アカウント設定リンクが非表示）

**目的:** 未ログイン時はアカウント設定リンクが表示されないことを確認する

**前提条件:** 未ログイン状態

**テストステップ:**
1. `/plans` ページを開く（認証状態ロードなし）
2. 「有効化方法」セクションを確認

**期待結果:**
- 有効化手順の説明文（3ステップ）は表示される
- 「アカウント設定へ」ボタンは表示されない
- ヘッダーにダッシュボードリンクではなく「ホーム」リンクが表示される

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/plans
agent-browser wait --load networkidle
agent-browser snapshot
```

---

## 2. アカウント設定ページ - 支援セクション

### TC-1011: アカウント設定のセクション順序確認

**目的:** セクションが「言語設定 → 支援」の順で表示されることを確認する

**前提条件:** ログイン済みの認証状態

**テストステップ:**
1. 認証状態をロードする
2. `https://twica.bluemoon.works/dashboard/account` を開く
3. スナップショットでセクションの順序を確認
4. スクリーンショットを取得

**期待結果:**
- 1番目のセクション: 言語設定（「言語設定」「Language」という見出し）
- 2番目のセクション: 支援（「支援」という見出し）

**実装例:**
```bash
agent-browser state load .e2e-auth-state-viewer-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser screenshot /tmp/tc1011-account-order.png
agent-browser snapshot
```

---

### TC-1012: コードフォームの「支援特典について」リンク

**目的:** 支援セクションのコード入力フォームに「支援特典について」リンクが存在することを確認する

**前提条件:** ログイン済みの認証状態

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/account` を開く
2. 支援セクションを確認
3. 「支援特典について」リンクの存在を確認
4. リンクのhrefを確認
5. リンクをクリックして遷移先を確認

**期待結果:**
- コード入力フォームの説明文の隣に「支援特典について」リンクが表示される
- リンクが `/plans` を指している
- クリックすると `/plans` ページに遷移する

**実装例:**
```bash
agent-browser state load .e2e-auth-state-viewer-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot -i
# 「支援特典について」リンクをクリック
agent-browser click @eN  # Nはリンクのref番号
agent-browser wait --load networkidle
agent-browser get url
# → https://twica.bluemoon.works/plans であることを確認
```

---

### TC-1013: 現在の特典表示確認

**目的:** 現在の特典が正しく表示されることを確認する

**前提条件:** ログイン済みの認証状態

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/account` を開く
2. 支援セクションで現在の特典バッジを確認
3. 追加ストレージ容量の表示を確認

**期待結果:**

| 特典 | バッジ色 | ストレージ表示 |
|---|---|---|
| basic | グレー | +0 MB（デフォルト） |
| support | ブルー | +250 MB |
| patron | イエロー | +500 MB |
| twitch_sub | パープル | +500 MB |

**実装例:**
```bash
agent-browser state load .e2e-auth-state-viewer-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot
agent-browser screenshot /tmp/tc1013-current-plan.png
```

---

### TC-1014: 無効な支援コードのエラー表示

**目的:** 無効なコードを入力した場合にエラーメッセージが表示されることを確認する

**前提条件:** ログイン済みの認証状態

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/account` を開く
2. 支援セクションのコード入力フォームに無効なコードを入力
3. 「有効化」ボタンをクリック
4. エラーメッセージが表示されることを確認

**テストデータ:**
- 無効なコード: `invalid-code-123456`

**期待結果:**
- エラーメッセージが赤色で表示される
- コードのアクティベーションは失敗する
- 特典は変更されない（素地のまま）
- フォームの入力値は保持される

**実装例:**
```bash
agent-browser state load .e2e-auth-state-viewer-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot -i
# コード入力フィールドにテキストを入力
agent-browser fill @eN "invalid-code-123456"  # Nはコード入力フィールドのref番号
agent-browser click @eM  # Mは「有効化」ボタンのref番号
agent-browser wait 2000
agent-browser snapshot
agent-browser screenshot /tmp/tc1014-invalid-code.png
```

---

### TC-1015: 有効な支援コードのアクティベーション（手動確認ケース）

**目的:** 有効なコードで特典が正しくアクティベートされることを確認する

**前提条件:**
- ログイン済みの認証状態（素地のユーザー）
- 有効な支援コード（管理ダッシュボードで事前発行）

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/account` を開く
2. 現在の特典が「素地」であることを確認
3. コード入力フィールドに有効なコードを入力
4. 「有効化」ボタンをクリック
5. 成功メッセージが表示されることを確認
6. 特典バッジが変わることを確認

**期待結果:**
- 「助力の特典が有効化されました」等の成功メッセージが緑色で表示される
- 特典バッジが「助力」（ブルー）または「ご贔屓」（イエロー）に変わる
- 追加ストレージ表示が更新される（+250MB or +500MB）
- コード入力フィールドがクリアされる

**注意:** このテストは実際のコードが必要なため、E2E自動化には適さない。スモークテストとして手動で確認する。

---

### TC-1016: 特典の解除（素地への復帰）

**目的:** 「素地に戻す」ボタンで特典が解除されることを確認する

**前提条件:**
- ログイン済みの認証状態（support または patron のユーザー）

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/account` を開く
2. 「素地に戻す」ボタンが表示されることを確認
3. ボタンをクリック
4. 確認ダイアログが表示されることを確認
5. ダイアログを承認
6. 成功メッセージを確認
7. 特典が素地に戻ることを確認

**期待結果:**
- 「素地に戻す」ボタンが表示される（basic・twitch_sub の場合は表示されない）
- クリック時に確認ダイアログが表示される
- 承認後に「素地に戻しました」メッセージが表示される
- 特典バッジが「素地」（グレー）に変わる
- 追加ストレージが「+0 MB（デフォルト）」に戻る

**素地・Twitchサブスクでは非表示であることの確認:**
- 素地のユーザーには「素地に戻す」ボタンが表示されない
- Twitchサブスクのユーザーにも「素地に戻す」ボタンが表示されない

**実装例:**
```bash
agent-browser state load .e2e-auth-state-supporter-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot -i
# 「素地に戻す」ボタンをクリック
agent-browser click @eN  # Nは「素地に戻す」ボタンのref番号
agent-browser wait 1000
# 確認ダイアログを承認
agent-browser accept-dialog
agent-browser wait 2000
agent-browser snapshot
agent-browser screenshot /tmp/tc1016-downgrade.png
```

---

## 3. ストレージ超過時の特典リンク

### TC-1021: ダッシュボードのストレージ超過バナーにリンク表示

**目的:** ストレージ超過時のバナーに「支援特典について」リンクが表示されることを確認する

**前提条件:**
- ログイン済みの配信者（streamer）
- ストレージが上限を超えている状態（テスト環境でのみ再現可能）

**テストステップ:**
1. 配信者の認証状態をロードする
2. `https://twica.bluemoon.works/dashboard` を開く
3. 赤色のストレージ超過バナーが表示されている場合、内容を確認
4. 「支援特典について」リンクの存在を確認

**期待結果:**
- ストレージ超過バナー（赤色）に「支援特典について」リンクが表示される
- リンクをクリックすると `/plans` ページに遷移する
- バナーに「カード管理へ」ボタンも表示される

**補足:** ストレージ超過状態の再現が困難な場合は、ソースコードの確認で代替する。

---

### TC-1022: カード管理ページのストレージ警告にリンク表示

**目的:** カード管理ページのストレージ警告箇所に「支援特典について」リンクが表示されることを確認する

**前提条件:**
- ログイン済みの配信者（streamer）
- ストレージが制限状態に近い、または超えている

**テストステップ:**
1. 配信者の認証状態をロードする
2. `https://twica.bluemoon.works/dashboard/cards` を開く
3. ストレージ使用量の表示を確認
4. `?` ボタンをクリックして容量制限の説明を表示
5. 「支援特典について」リンクの確認

**期待結果（通常状態）:**
- ストレージ使用量が「画像使用量: Xmb / Ymb」の形式で表示される
- `?` ボタンをクリックすると容量制限の説明テキストが表示される
- 説明テキストの下に「支援特典について」リンクが表示される
- リンクをクリックすると `/plans` に遷移する

**期待結果（制限状態）:**
- 黄色バナー「アップロード機能が制限されています」が表示される
- バナー内に「支援特典について」リンクが表示される

**期待結果（超過状態）:**
- 赤色バナー「アップロード機能が制限されています」が表示される
- バナー内に「支援特典について」リンクが表示される

**実装例:**
```bash
agent-browser state load .e2e-auth-state-streamer-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/cards
agent-browser wait --load networkidle
agent-browser snapshot -i
# ?ボタンをクリック
agent-browser click @eN  # Nは?ボタンのref番号
agent-browser wait 500
agent-browser snapshot
agent-browser screenshot /tmp/tc1022-storage-link.png
```

---

## 4. リリースノートページ

### TC-1031: リリースノートv1.28.0セクションの表示

**目的:** リリースノートページにv1.28.0の新機能が正しく掲載されていることを確認する

**前提条件:** ブラウザが起動している（ログイン不要）

**テストステップ:**
1. `https://twica.bluemoon.works/releases` を開く
2. v1.28.0セクションの存在を確認
3. v1.28.0の内容を確認

**期待結果:**
- ページ最上部（v1.27.0より上）に `v1.28.0` バッジが表示される
- 日付 `2026-02-24` が表示される
- 以下の項目が含まれる：
  - 「Twitchサブスクによる特典自動適用」セクション
  - 「支援者向け問い合わせフォーム」セクション
  - 「特典の解除機能」セクション
  - 「その他の改善・修正」セクション（ストレージ容量修正・スコープバグ修正）

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/releases
agent-browser wait --load networkidle
agent-browser snapshot
agent-browser screenshot /tmp/tc1031-release-notes.png
```

---

### TC-1032: v1.27.0のストレージ容量記述の確認

**目的:** v1.27.0の特典一覧に正しいストレージ容量（250MB/500MB）が記載されていることを確認する

**前提条件:** ブラウザが起動している

**テストステップ:**
1. `https://twica.bluemoon.works/releases` を開く
2. v1.27.0セクションの特典一覧を確認

**期待結果:**
- 助力: 「+250MB」または「+250MB、Full HD（1920px幅）画像対応」
- ご贔屓: 「+500MB」または「+500MB、4K（3840px幅）画像対応」
- 旧表記「+500MB / +1GB」が残っていない
- 「支援特典について」リンクが表示される

---

### TC-1033: リリースノートの特典リンク

**目的:** v1.27.0セクション内の「支援特典について」リンクが機能することを確認する

**前提条件:** ブラウザが起動している

**テストステップ:**
1. `https://twica.bluemoon.works/releases` を開く
2. v1.27.0セクション内の「支援特典について」リンクをクリック
3. 遷移先URLを確認

**期待結果:**
- リンクが `/plans` を指している
- クリックすると `https://twica.bluemoon.works/plans` に遷移する

**実装例:**
```bash
agent-browser open https://twica.bluemoon.works/releases
agent-browser wait --load networkidle
agent-browser snapshot -i
# 「支援特典について」リンクをクリック
agent-browser click @eN
agent-browser wait --load networkidle
agent-browser get url
# → https://twica.bluemoon.works/plans を確認
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
