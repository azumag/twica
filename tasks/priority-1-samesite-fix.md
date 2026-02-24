# Task: SameSite属性の修正 (優先度1)

## 目標
CSRFトークンcookieのsameSite属性を'strict'から'lax'に変更する

## 設計書参照
docs/ARCHITECTURE.md - 「質問2: SameSite属性の適切な設定」セクション（0924-0954行目）

## 変更内容

### 対象ファイル
- src/lib/csrf.ts

### 変更箇所
```typescript
// 変更前
cookieStore.set('csrf_token', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',  // ← 変更対象
  path: '/',
  maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
})

// 変更後
cookieStore.set('csrf_token', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',  // ← 'lax'に変更
  path: '/',
  maxAge: SESSION_CONFIG.MAX_AGE_SECONDS,
})
```

## 理由
- OAuthコールバックは外部ドメインからのリダイレクトであるため、sameSite='lax'が必要
- sameSite='lax'はトップレベルナビゲーションでcookieを許可し、クロスサイトPOSTリクエストでcookieをブロックする
- これにより、OAuthコールバックは正常に動作し、CSRF攻撃は防止される

## 期待される結果
- OAuthコールバックが正常に動作する
- CSRF攻撃（POSTリクエスト）は防止される

## 検証方法
1. OAuth認証フローを実行
2. トークン取得が成功することを確認
3. セッションにcsrfTokenHashが保存されていることを確認
