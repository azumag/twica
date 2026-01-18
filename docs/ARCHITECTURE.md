# Issue #50: Fix Sentry Multiple Initialization Error

## 概要

クライアント側で Sentry が複数回初期化されており、警告が表示されている問題を修正する。

## 機能要件

- Sentry の初期化をクライアント側で1回のみ行う
- Sentry の機能（エラートラッキング、パフォーマンス監視、セッションリプレイ）を維持する
- 警告メッセージを解消する

## 非機能要件

- エラートラッキングの信頼性を維持する
- パフォーマンス監視を継続する
- 既存のエラーハンドリング機能に影響を与えない

## 受け入れ基準

- クライアント側で Sentry.init() が1回のみ呼び出されること
- ブラウザコンソールに "You are calling `Sentry.init()` more than once" の警告が表示されないこと
- エラーが正しく Sentry に送信されること
- セッションリプレイが正しく動作すること
- CI/CD パイプラインが成功すること

## 設計方針

### 問題分析

現在、`src/instrumentation-client.ts` で以下の2箇所から Sentry が初期化されている：

1. `src/instrumentation-client.ts` 内の直接の `Sentry.init()` 呼び出し
2. `import "../sentry.client.config"` による `sentry.client.config.ts` のロード

これにより、Sentry が2回初期化され、警告が表示されている。

### 解決策

**オプション1: instrumentation-client.ts から直接の Sentry.init() を削除**
- `instrumentation-client.ts` 内の `Sentry.init()` 呼び出しを削除
- `sentry.client.config.ts` のみを使用
- これが最もクリーンな解決策

**オプション2: sentry.client.config.ts のインポートを削除**
- `instrumentation-client.ts` の `import "../sentry.client.config"` を削除
- `instrumentation-client.ts` 内の `Sentry.init()` のみを使用

### 採用する設計

**オプション1を採用する。**

**理由:**
- `sentry.client.config.ts` は Sentry SDK が提供する標準的な設定ファイル形式
- 将来的な設定の管理において、専用の設定ファイルを使用することがベストプラクティス
- `instrumentation-client.ts` は Next.js 15+ App Router での初期化フックの役割に集中すべき

### 実装手順

1. `src/instrumentation-client.ts` から `Sentry.init()` 呼び出し部分を削除
2. `sentry.client.config.ts` の設定が適切であることを確認
3. `instrumentation-client.ts` から `sentry.client.config.ts` のインポートを維持
4. 必要に応じて、`instrumentation-client.ts` にコメントを追加して、役割を明確にする

### 実装詳細

#### 変更するファイル: `src/instrumentation-client.ts`

```typescript
// 変更前
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  integrations: [
    Sentry.globalHandlersIntegration({
      onerror: true,
      onunhandledrejection: true,
    }),
  ],
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  replaysSessionSampleRate: process.env.NODE_ENV === "production" ? 0.01 : 0.1,
  replaysOnErrorSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  beforeSend(event) {
    if (event.user) {
      delete event.user.email;
      delete event.user.ip_address;
    }
    return event;
  },
});
import "../sentry.client.config";

// 変更後
// This file is REQUIRED for Next.js 15+ App Router to initialize Sentry on the client-side
// DO NOT DELETE - Sentry SDK does not auto-initialize in Next.js App Router
import "../sentry.client.config";
```

#### 確認すべきファイル: `sentry.client.config.ts`

`sentry.client.config.ts` に以下の設定が含まれていることを確認：

- `replayIntegration()` （セッションリプレイ用）
- `globalHandlersIntegration()` （グローバルエラーハンドラー用）
- トレースサンプリング設定
- セッションリプレイサンプリング設定
- `beforeSend` フック

### トレードオフ

#### メリット
- コードがよりクリーンになり、責任が明確になる
- 標準的な Sentry 設定ファイル形式を使用できる
- 設定の管理が容易になる

#### デメリット
- 特になし。この変更は技術的改善であり、機能には影響しない

### リスク

- セッションリプレイやエラートラッキングが正しく動作しない可能性
- 回避策: ローカル環境と CI/CD で動作確認を行う

### テスト計画

1. 開発環境でアプリケーションを起動し、コンソールに警告が表示されないことを確認
2. 意図的なエラーを発生させ、Sentry に正しく送信されることを確認
3. CI/CD パイプラインが成功することを確認
4. （もし可能であれば）セッションリプレイが動作していることを確認

## 参考資料

- Issue #50: Sentry.init() multiple initialization error
- Next.js App Router Documentation
- Sentry Next.js SDK Documentation
