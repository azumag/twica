# Discord連携機能 E2Eテストシナリオ

## 対象機能

- Discord連携セクション（アカウント設定）
- Discordログイン（OAuthフロー）
- Twitchサブスクプラン（Discord連携による自動適用）
- Discord連携解除・ロール更新

---

## 前提条件・注意事項

- Discord OAuth フローは実際の Discord アカウントが必要
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `DISCORD_GUILD_ID` / `DISCORD_SUB_ROLE_ID` が設定されていることを前提とする
- 環境変数が未設定の場合、Discord連携セクション自体は表示されるが、OAuthフロー開始時にエラーが返る

---

## 1. Discord連携セクションの表示

### TC-1201: 未連携状態のDiscord連携セクション表示

**目的:** Discord未連携のユーザーがアカウント設定を開いた際に、連携セクションが正しく表示されることを確認する

**前提条件:**
- ログイン済みの認証状態（Discord未連携のユーザー）

**テストステップ:**
1. 認証状態をロードする
2. `https://twica.bluemoon.works/dashboard/account` を開く
3. Discord連携セクションを確認
4. スクリーンショットを取得

**期待結果:**
- Discord連携セクションが表示される（ページ上部、言語設定の前）
- セクション見出しが表示される（「Discord連携」相当のテキスト）
- 「未連携」バッジ（グレー）が表示される
- 「Discordと連携する」（または類似の）ボタンが表示される
- 「連携済み」バッジ・ロール情報・解除ボタンは表示されない

**実装例:**
```bash
agent-browser state load .e2e-auth-state-viewer-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot
agent-browser screenshot /tmp/tc1201-discord-unlinked.png
```

---

### TC-1202: Discord連携ボタンのOAuthリダイレクト

**目的:** Discord連携ボタンをクリックすると Discord OAuthページにリダイレクトされることを確認する

**前提条件:**
- ログイン済みの認証状態（Discord未連携）
- Discord連携がサーバーで設定済み

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/account` を開く
2. Discord連携セクションの「Discordと連携する」ボタンをクリック
3. リダイレクト先URLを確認
4. 元のページに戻る

**期待結果:**
- `/api/auth/discord/login?redirect=true` にリクエストが送られる
- `discord.com/oauth2/authorize` または Discord認証ページにリダイレクトされる
- URLパラメータに `scope=identify+guilds.members.read` が含まれる
- `state` パラメータが含まれる（CSRF対策）

**注意:** 実際のDiscord認証は完了させない（TwitchアカウントとDiscordアカウントのリンクが発生するため）

**実装例:**
```bash
agent-browser state load .e2e-auth-state-viewer-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot -i
# Discord連携ボタンをクリック
agent-browser click @eN  # NはDiscord連携ボタンのref番号
agent-browser wait 2000
agent-browser get url
# discord.com/oauth2/authorize であることを確認
agent-browser screenshot /tmp/tc1202-discord-oauth.png
agent-browser back
agent-browser wait --load networkidle
```

---

### TC-1203: Discord環境変数未設定時の連携ボタン動作

**目的:** Discord環境変数が未設定の場合でも連携セクション自体は表示されることを確認する（環境変数オプション確認）

**前提条件:** このテストは環境変数が設定されていない場合のみ実施

**期待結果:**
- Discord連携セクションは表示される
- 連携ボタンをクリックすると「Discord is not configured」等のエラーが返る
- 他の機能（言語設定・支援プラン）は正常に動作する

---

## 2. Discord連携済み状態

### TC-1211: 連携済み状態のDiscord連携セクション表示

**目的:** Discord連携済みユーザーのアカウント設定が正しく表示されることを確認する

**前提条件:**
- ログイン済みの認証状態（Discord連携済みのユーザー）

**テストステップ:**
1. Discord連携済みの認証状態をロードする
2. `https://twica.bluemoon.works/dashboard/account` を開く
3. Discord連携セクションを確認
4. スクリーンショットを取得

**期待結果:**
- 「連携済み」バッジ（緑色）が表示される
- Discord ユーザーIDが表示される（例：「Discord ID: 1234567890」）
- ロールステータスが表示される
  - サブスクロールあり: 「サブスクロール: 有効」等（緑色）
  - サブスクロールなし: 「サブスクロール: 未取得」等（グレー）
- 「ロール状態を更新」ボタンが表示される
- 「連携解除」ボタンが表示される
- 「Discordと連携する」ボタンは表示されない

**実装例:**
```bash
agent-browser state load .e2e-auth-state-discord-linked-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot
agent-browser screenshot /tmp/tc1211-discord-linked.png
```

---

### TC-1212: Twitchサブスクプランの自動適用確認

**目的:** Discordサブスクライバーロールを持つユーザーが「Twitchサブスク」プランとして認識されることを確認する

**前提条件:**
- Discord連携済みかつ Twiitchサブスクライバーロールを持つユーザー

**テストステップ:**
1. 認証状態をロードする
2. `https://twica.bluemoon.works/dashboard/account` を開く
3. 支援プランセクションを確認

**期待結果:**
- 現在のプランが「Twitchサブスク」（パープルバッジ）で表示される
- 追加ストレージが「+500 MB」と表示される
- 「ベーシックに戻す」ボタンは表示されない（twitch_subはコードによるダウングレード不可）

**実装例:**
```bash
agent-browser state load .e2e-auth-state-twitch-sub-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot
agent-browser screenshot /tmp/tc1212-twitch-sub-plan.png
```

---

### TC-1213: ロール状態の更新

**目的:** 「ロール状態を更新」ボタンでDiscordサブスクロールの状態が更新されることを確認する

**前提条件:**
- Discord連携済みの認証状態

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/account` を開く
2. Discord連携セクションの「ロール状態を更新」ボタンをクリック
3. 結果メッセージを確認

**期待結果:**
- ボタンクリック後にローディング状態になる
- 成功時: 「ロール状態を更新しました」等のメッセージが表示される
- ページがリロードされてロールステータスが更新される
- 失敗時（Discord APIエラー等）: エラーメッセージが赤色で表示される

**実装例:**
```bash
agent-browser state load .e2e-auth-state-discord-linked-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot -i
# 「ロール状態を更新」ボタンをクリック
agent-browser click @eN  # Nはロール更新ボタンのref番号
agent-browser wait 3000
agent-browser snapshot
agent-browser screenshot /tmp/tc1213-refresh-role.png
```

---

### TC-1214: Discord連携の解除

**目的:** 「連携解除」ボタンでDiscordとの連携が解除されることを確認する

**前提条件:**
- Discord連携済みの認証状態
- **注意:** このテストを実行すると実際に連携が解除される。テスト用アカウントで実施すること。

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/account` を開く
2. Discord連携セクションの「連携解除」ボタンをクリック
3. 確認ダイアログで「OK」をクリック
4. 結果を確認

**期待結果:**
- 確認ダイアログが表示される
- 承認後: 「連携を解除しました」等のメッセージが表示される
- ページがリロードされる
- Discord連携セクションが「未連携」状態に変わる
- 「連携済み」バッジ・Discord ID・解除ボタンが消える
- 「Discordと連携する」ボタンが表示される
- プランが「Twitchサブスク」だった場合、「ベーシック」に戻る

**実装例:**
```bash
agent-browser state load .e2e-auth-state-discord-linked-prod.json
agent-browser open https://twica.bluemoon.works/dashboard/account
agent-browser wait --load networkidle
agent-browser snapshot -i
# 「連携解除」ボタンをクリック
agent-browser click @eN  # Nは連携解除ボタンのref番号
agent-browser wait 1000
# 確認ダイアログを承認
agent-browser accept-dialog
agent-browser wait 3000
agent-browser snapshot
agent-browser screenshot /tmp/tc1214-discord-unlinked.png
```

---

## 3. エラーケース・エッジケース

### TC-1221: 既に別のTwitchアカウントに連携済みのDiscordアカウントの再連携エラー

**目的:** 同一Discordアカウントを複数のTwitchアカウントに連携しようとした場合にエラーが表示されることを確認する

**前提条件:**
- Discord連携未完了の Twitch ユーザー
- そのDiscordアカウントが他の Twitch アカウントに連携済み

**期待結果:**
- OAuthコールバック後、`/dashboard/account?discord_error=DISCORD_ALREADY_LINKED` にリダイレクトされる
- アカウント設定ページに「このDiscordアカウントはすでに別のアカウントに連携されています」等のエラーメッセージが表示される（赤色）
- Discord連携セクションは「未連携」状態のまま

---

### TC-1222: Discord連携ボタン連打防止

**目的:** ローディング中に連携ボタンを連打してもリクエストが重複しないことを確認する

**前提条件:** ログイン済みの認証状態

**テストステップ:**
1. `https://twica.bluemoon.works/dashboard/account` を開く
2. 「ロール状態を更新」ボタンを素早く複数回クリック

**期待結果:**
- ボタンがクリック後にdisabled状態になる
- 二重リクエストが発生しない
- 最終的に1回分の結果のみ表示される

---

## テスト実行ログ形式

```
テストケースID: TC-XXXX
実行日時: YYYY-MM-DD HH:MM:SS
結果: PASS / FAIL / SKIP
備考: [問題点や気づいた点]
スクリーンショット: /tmp/tcXXXX-*.png
```
