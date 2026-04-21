# Issue #399 実装計画: 状態変更APIへのCSRF検証追加

## 目的
- Issue #399 の受け入れ条件を満たす
  1. 対象APIがCSRF不正時に403を返す
  2. `GET /api/auth/logout` が状態変更を行わない
  3. EventSub登録/解除とreauthにCSRFテストがある

## 業界標準調査サマリ
- OWASP CSRF Prevention Cheat Sheet は「状態変更操作は GET を使わない」「POST/PUT/DELETE に CSRF トークン検証を必須化」を推奨
- 本プロジェクトは Double Submit Cookie に近い HttpOnly Cookie + session hash + Origin/Referer 検証方式を採用済み（`validateCSRFToken`）
- ログアウトをリンクで実装するのはアンチパターン（プリフェッチ/画像/クローラで誤発火）。POST フォームが推奨。

## 範囲（変更対象ファイル）

### バックエンド（CSRF検証を追加）
1. `src/app/api/auth/reauth/route.ts` — POST の冒頭で `validateCSRFToken()` を呼び失敗時 403
2. `src/app/api/twitch/eventsub/subscribe/route.ts` — POST / DELETE の冒頭で `validateCSRFToken()` を呼び失敗時 403（GET はそのまま）
3. `src/app/api/auth/logout/route.ts` — GET ハンドラを削除（Next.js Route Handlers は未定義メソッドに自動で 405 を返す）

### フロントエンド（GET→POST 変換）
4. `src/components/LogoutButton.tsx` — 新規。クライアントコンポーネントで `/api/auth/logout` へ POST 送信しリダイレクト。
   - `credentials: 'include'` でブラウザが CSRF クッキーと session クッキーを自動送信
   - 余分にヘッダーを送ることはしない（既存サーバー実装は Cookie を読む）
5. `src/components/Header.tsx` — `<a href="/api/auth/logout">` を `<LogoutButton>` に置換
6. `src/components/TopPageHeader.tsx` — 同上

既存 `fetch('/api/twitch/eventsub/subscribe', { credentials: 'include' })` は Cookie を同時送信するため、サーバー側 `validateCSRFToken` は追加実装なしで機能する（Origin ヘッダーはブラウザが付与、CSRF Cookie も SameSite=Lax で送信される）。`ChannelPointSettings.tsx` は変更不要。

### テスト
7. `tests/unit/auth-reauth-scopes.test.ts` — CSRF 拒否時 403 のケースを追加
8. `tests/unit/eventsub-subscribe-api.test.ts` — 新規。POST/DELETE の CSRF 拒否/承認テスト
9. `tests/unit/auth-logout-api.test.ts` — 新規。POST の CSRF 拒否/承認テスト。GET ハンドラが未定義であることを確認する test（route export をチェック）

## 実装詳細

### 1. reauth/route.ts
```ts
export async function POST(request: Request) {
  try {
    // レートリミットより前に CSRF を検証（不正アクセスは早期に弾く）
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

    const session = await getSession()
    // ... 既存ロジック
```

### 2. eventsub/subscribe/route.ts
POST と DELETE それぞれの冒頭（レートリミット/認可より前）で `validateCSRFToken()` を呼ぶ。GET はそのまま（状態変更しない）。

### 3. logout/route.ts
- GET エクスポートを削除
- POST は既に CSRF 検証済みのためそのまま
- 旧 GET ブックマークを踏んだユーザーは 405 を受け取る。業界標準（例: GitHub）でもログアウトは POST のみ。

### 4. LogoutButton.tsx
```tsx
'use client'

import { useState, useTransition } from 'react'

interface Props {
  className?: string
  label: string
  children: React.ReactNode  // アイコン + テキストをそのまま描画
}

export function LogoutButton({ className, label, children }: Props) {
  const [isPending, startTransition] = useTransition()

  const handleLogout = () => {
    startTransition(async () => {
      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include',
        })
        if (response.redirected) {
          window.location.href = response.url
        } else {
          window.location.href = '/'
        }
      } catch {
        // ネットワーク失敗時も UI を回復するためトップへ遷移
        window.location.href = '/'
      }
    })
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={isPending}
      className={className}
      title={label}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  )
}
```

### 5. Header.tsx / TopPageHeader.tsx
`<a>` 要素を `<LogoutButton>` に置換。既存のアイコン/テキスト/クラス名はそのまま children として渡す。

## リスクと緩和
- 旧 GET logout リンクは 405 になる → 社内で利用が残っていないことを確認。UI 側は置換済み。
- クライアントサイドでの fetch 失敗時に UI がハングしないよう finally / catch を入れる
- LogoutButton は `useTransition` によるローディング表示で二重クリック抑止

## 受け入れ確認マッピング
| 受け入れ条件 | 対応 |
|---|---|
| 対象APIがCSRF不正時に403を返す | 1, 2 のコード変更 + 7, 8 のテスト |
| GET logout が状態変更を行わない | 3 でGETハンドラ削除 + 9 のテスト |
| EventSub登録/解除とreauthにCSRFテストがある | 7, 8 |

## テスト戦略
- vitest + NextRequest ベースの既存パターンを踏襲
- `validateCSRFToken` をモックし、`{ valid: false }` を返す場合に 403 が返ることを検証
- eventsub は POST/DELETE で分岐するのでテストも分ける
- logout の GET については `route.ts` から GET が export されていない事実を確認するテストを追加
