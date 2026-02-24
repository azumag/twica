# Issue #56, #57: Error Handling and Type Safety Improvements

## 概要

本設計は、以下の問題を解決するためのものです：

1. **Issue #56**: "Error: No access token available" - Twitch API呼び出し時のエラーハンドリング改善
2. **Issue #57**: "API Auth Logout API: GET: [object Object]" - エラーログの改善
3. **CI Build Failure**: TypeScript型エラーによるビルド失敗の修正

## 問題分析

### 1. Issue #56: No access token available

**発生箇所**: `src/app/api/twitch/rewards/route.ts:14`

```typescript
async function getTwitchAccessTokenOrError(twitchUserId: string): Promise<string> {
  const accessToken = await getTwitchAccessToken(twitchUserId);

  if (!accessToken) {
    throw new Error(ERROR_MESSAGES.NO_ACCESS_TOKEN_AVAILABLE);
  }

  return accessToken;
}
```

**問題点**:
- `getTwitchAccessToken` が `null` を返す原因が複数考えられる：
  1. ユーザーデータベースにトークンが存在しない
  2. トークンが期限切れでリフレッシュに失敗した
  3. トークンが削除されている（ログアウト時など）

- エラーメッセージが汎用的すぎて、デバッグが困難
- Sentryへのエラー報告時に詳細が不足

**影響範囲**:
- `/api/twitch/rewards` (GET, POST)
- Twitch APIを使用する他のエンドポイント（今後追加される可能性）

### 2. Issue #57: Logout API error handling

**発生箇所**: `src/app/api/auth/logout/route.ts:69`

```typescript
} catch (error) {
  return handleApiError(error, "Auth Logout API: GET")
}
```

**問題点**:
- `error` が `Error` インスタンスでない場合、Sentry に `[object Object]` として記録される
- エラーの詳細が失われ、デバッグが困難

**Sentryエラーハンドラの確認** (`src/lib/sentry/error-handler.ts`):
```typescript
export function reportApiError(endpoint: string, method: string, error: Error | unknown, ...) {
  if (error instanceof Error) {
    Sentry.captureException(error)
  } else {
    Sentry.captureMessage(`${method} ${endpoint}: ${String(error)}`, 'error')
  }
}
```

**問題**: `String(error)` が `[object Object]` を返す場合がある

### 3. CI Build Failure: TypeScript型エラー

**発生箇所**: `src/app/battle/stats/page.tsx:134`

```
Type error: Property 'version' is missing in type '{ twitchUserId: string; twitchUsername: string; twitchDisplayName: string; twitchProfileImageUrl: string; broadcasterType: string; expiresAt: number; }' but required in type 'Session'.
```

**問題点**:
- `src/lib/session.ts` の `Session` インターフェースには `version` プロパティが追加された
- クライアントコンポーネントの `useState` 型定義が更新されていない
- CIビルドが失敗している

## 機能要件

### 1. エラーハンドリングの改善 (Issue #56)

1. **アクセストークン取得のエラー詳細化**:
   - トークンがない場合の詳細なエラーメッセージ
   - データベースエラーとトークン期限切れを区別

2. **ユーザーへのわかりやすいエラーメッセージ**:
   - 再ログインを促すメッセージ
   - Twitch連携が必要なことを明示

### 2. ログの改善 (Issue #57)

1. **エラーオブジェクトの適切な処理**:
   - `Error` インスタンスでない場合も詳細を記録
   - オブジェクトのキーと値をログに出力

2. **Sentryへの詳細なエラー報告**:
   - エラータイプの分類
   - スタックトレースの記録

### 3. 型定義の修正 (CI Build Fix)

1. **型定義の整合性**:
   - すべてのクライアントコンポーネントで `Session` 型を使用
   - `version` プロパティを含める

## 非機能要件

1. **可用性**:
   - エラー発生時もAPIは応答を返す必要がある
   - エラーメッセージはユーザーフレンドリー

2. **可観測性**:
   - すべてのエラーをSentryに記録
   - 詳細なログ出力

3. **互換性**:
   - 既存のAPIコントラクトを維持
   - クライアント側の変更を最小限に

## 受け入れ基準

1. **Issue #56**:
   - アクセストークンがない場合、適切なエラーメッセージが返される
   - Sentryに詳細なエラー情報が記録される
   - ユーザーに再ログインを促すメッセージが表示される

2. **Issue #57**:
   - ログアウトAPIのエラーが適切に記録される
   - `[object Object]` というエラーメッセージが出ない
   - Sentryに詳細なエラー情報が記録される

3. **CI Build Fix**:
   - TypeScriptビルドが成功する
   - CIがパスする
   - すべてのクライアントコンポーネントの型定義が正しい

## 設計方針

### アーキテクチャ決定

**選択: エラーハンドリングの一貫性と型安全性の強化**

### 設計1: アクセストークン取得の改善

**ファイル**: `src/lib/twitch/token-manager.ts`

**変更点**:
1. `getTwitchAccessToken` の戻り値の型を変更し、エラー情報を含める
2. カスタムエラークラスを作成

**実装**:
```typescript
export class TwitchTokenError extends Error {
  constructor(
    message: string,
    public readonly code: 'NO_TOKEN' | 'REFRESH_FAILED' | 'DATABASE_ERROR',
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'TwitchTokenError';
  }
}

export async function getTwitchAccessToken(twitchUserId: string): Promise<string> {
  const supabaseAdmin = getSupabaseAdmin();

  const { data: user, error: dbError } = await supabaseAdmin
    .from('users')
    .select('twitch_access_token, twitch_refresh_token, twitch_token_expires_at')
    .eq('twitch_user_id', twitchUserId)
    .single();

  if (dbError) {
    throw new TwitchTokenError(
      'Failed to fetch user tokens from database',
      'DATABASE_ERROR',
      dbError
    );
  }

  if (!user || !user.twitch_access_token || !user.twitch_refresh_token) {
    throw new TwitchTokenError(
      'No Twitch tokens found for user',
      'NO_TOKEN'
    );
  }

  const now = new Date();
  const expiresAt = new Date(user.twitch_token_expires_at);

  if (expiresAt > now) {
    return user.twitch_access_token;
  }

  return await refreshTwitchAccessToken(twitchUserId, user.twitch_refresh_token);
}

async function refreshTwitchAccessToken(twitchUserId: string, refreshToken: string): Promise<string> {
  try {
    const tokens = await refreshTwitchToken(refreshToken);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    const supabaseAdmin = getSupabaseAdmin();
    const { error } = await supabaseAdmin
      .from('users')
      .update({
        twitch_access_token: tokens.access_token,
        twitch_refresh_token: tokens.refresh_token,
        twitch_token_expires_at: expiresAt.toISOString(),
      })
      .eq('twitch_user_id', twitchUserId);

    if (error) {
      throw error;
    }

    return tokens.access_token;
  } catch (error) {
    logger.error('Failed to refresh Twitch access token', { twitchUserId, error });
    throw new TwitchTokenError(
      'Failed to refresh Twitch access token',
      'REFRESH_FAILED',
      error instanceof Error ? error : undefined
    );
  }
}
```

**APIルートの修正**: `src/app/api/twitch/rewards/route.ts`

```typescript
import { TwitchTokenError } from '@/lib/twitch/token-manager';
import { reportError } from '@/lib/sentry/error-handler';

async function getTwitchAccessTokenOrError(twitchUserId: string): Promise<string> {
  try {
    const accessToken = await getTwitchAccessToken(twitchUserId);
    return accessToken;
  } catch (error) {
    if (error instanceof TwitchTokenError) {
      // カスタムエラーの場合
      if (error.code === 'NO_TOKEN') {
        // 再ログインが必要
        reportError(error, {
          context: 'getTwitchAccessToken',
          code: error.code,
          userId: twitchUserId
        });
        throw new Error('Twitch連携が必要です。再ログインしてください。');
      } else if (error.code === 'REFRESH_FAILED') {
        // リフレッシュ失敗
        reportError(error, {
          context: 'getTwitchAccessToken',
          code: error.code,
          userId: twitchUserId
        });
        throw new Error('Twitchトークンの更新に失敗しました。再ログインしてください。');
      } else {
        // データベースエラー
        reportError(error, {
          context: 'getTwitchAccessToken',
          code: error.code,
          userId: twitchUserId
        });
        throw new Error('サーバーエラーが発生しました。');
      }
    }
    // 予期せぬエラー
    reportError(error, {
      context: 'getTwitchAccessToken',
      userId: twitchUserId
    });
    throw new Error('サーバーエラーが発生しました。');
  }
}
```

**定数の追加**: `src/lib/constants.ts`
```typescript
export const ERROR_MESSAGES = {
  // 既存のエラーメッセージ...
  NO_ACCESS_TOKEN_AVAILABLE: 'Twitch連携が必要です。再ログインしてください。',
  TOKEN_REFRESH_FAILED: 'Twitchトークンの更新に失敗しました。再ログインしてください。',
  DATABASE_ERROR: 'データベースエラーが発生しました。',
} as const
```

### 設計2: エラーハンドラの改善

**ファイル**: `src/lib/error-handler.ts`

**変更点**: `handleApiError` 関数で非Error型のエラーを適切に処理

**実装**:
```typescript
export function handleApiError(error: unknown, context: string): NextResponse {
  logger.error(`${context}:`, error)
  reportApiError(context, 'API', error)

  // エラーメッセージの決定
  let userMessage = 'Internal server error';

  if (error instanceof Error) {
    // Errorインスタンスの場合
    userMessage = error.message || 'Internal server error';
  } else if (typeof error === 'string') {
    // 文字列の場合
    userMessage = error;
  } else if (error && typeof error === 'object') {
    // オブジェクトの場合（例: { message: '...', code: '...' }）
    if ('message' in error && typeof error.message === 'string') {
      userMessage = error.message;
    }
  }

  return NextResponse.json({ error: userMessage }, { status: 500 })
}
```

**Sentryエラーハンドラの改善**: `src/lib/sentry/error-handler.ts`

**変更点**: `reportApiError` 関数で非Error型のエラーを詳細に記録

**実装**:
```typescript
export function reportApiError(endpoint: string, method: string, error: Error | unknown, additionalContext?: Record<string, unknown>) {
  Sentry.withScope((scope) => {
    scope.setTag('endpoint', endpoint)
    scope.setTag('method', method)
    scope.setLevel('error')

    if (additionalContext) {
      Object.entries(additionalContext).forEach(([key, value]) => {
        scope.setExtra(key, value)
      })
    }

    if (error instanceof Error) {
      Sentry.captureException(error)
    } else {
      // 非Error型のエラーを詳細に記録
      let errorMessage = `${method} ${endpoint}: Unknown error`;

      if (typeof error === 'string') {
        errorMessage = `${method} ${endpoint}: ${error}`;
        scope.setExtra('errorType', 'string');
        scope.setExtra('errorValue', error);
      } else if (error && typeof error === 'object') {
        // オブジェクトの場合、すべてのキーと値を記録
        try {
          const errorJson = JSON.stringify(error, null, 2);
          errorMessage = `${method} ${endpoint}: Object error`;
          scope.setExtra('errorType', 'object');
          scope.setExtra('errorObject', error);
          scope.setExtra('errorJson', errorJson);
        } catch (e) {
          errorMessage = `${method} ${endpoint}: [Unserializable Object]`;
          scope.setExtra('errorType', 'unserializable');
          scope.setExtra('errorString', String(error));
        }
      } else if (error !== undefined && error !== null) {
        errorMessage = `${method} ${endpoint}: ${String(error)}`;
        scope.setExtra('errorType', typeof error);
        scope.setExtra('errorValue', error);
      }

      Sentry.captureMessage(errorMessage, 'error')
    }
  })
}
```

### 設計3: TypeScript型エラーの修正

**ファイル**: `src/app/battle/stats/page.tsx`

**変更点**: `session` stateの型定義を `Session` インターフェースと同期

**実装**:
```typescript
import { type Session } from '@/lib/session' // Session型をインポート

export default function BattleStatsPage() {
  const [session, setSession] = useState<Session | null>(null)  // Session型を使用
  // ... その他の実装は変更なし
}
```

**他のコンポーネントの確認と修正**:
- 以下のファイルで `session` stateの型定義を確認し、必要に応じて修正:
  - `src/app/dashboard/page.tsx`
  - `src/app/cards/page.tsx`
  - `src/app/streamer/settings/page.tsx`
  - その他のクライアントコンポーネント

## トレードオフ

### メリット

1. **エラーハンドリングの改善**:
   - ユーザーへのわかりやすいエラーメッセージ
   - デバッグが容易になる
   - Sentryへの詳細なエラー記録

2. **型安全性**:
   - TypeScriptビルドが成功
   - CIがパス
   - 型定義の整合性が保たれる

### デメリット

1. **コードの複雑性**:
   - カスタムエラークラスの導入
   - エラーハンドリングロジックの追加

2. **変更範囲**:
   - 複数のファイルを修正する必要がある
   - 既存のエラーハンドリングロジックを変更

## 実装ステップ

### Phase 1: TypeScript型エラーの修正（High Priority）
1. `src/app/battle/stats/page.tsx` の修正
2. 他のクライアントコンポーネントの型定義の確認と修正
3. ビルドとCIの確認

### Phase 2: アクセストークンエラーの改善（High Priority）
1. `TwitchTokenError` クラスの実装
2. `getTwitchAccessToken` の修正
3. APIルートのエラーハンドリングの改善
4. 定数の追加

### Phase 3: エラーハンドラの改善（Medium Priority）
1. `handleApiError` の改善
2. `reportApiError` の改善
3. ログ出力の確認

### Phase 4: テストとドキュメント
1. ユニットテストの実装
2. 手動テストの実施
3. GitHub Issuesの確認とクローズ

## 変更履歴

### 2026-01-19 - 初版

**理由**: Issue #56, #57 および CIビルド失敗の解決

**変更内容**:
- アクセストークン取得のエラーハンドリング改善
- ログアウトAPIのエラーハンドリング改善
- TypeScript型エラーの修正

## 参考資料

- Issue #56: Error: No access token available
- Issue #57: API Auth Logout API: GET: [object Object]
- Next.js Error Handling: https://nextjs.org/docs/app/building-your-application/routing/error-handling
- TypeScript Best Practices: https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html
