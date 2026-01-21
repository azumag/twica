// This file is REQUIRED for Next.js 15+ App Router to initialize Sentry on the client-side
// DO NOT DELETE - Sentry SDK does not auto-initialize in Next.js App Router
import * as Sentry from "@sentry/nextjs";
import "../sentry.client.config";

// Next.js 15+ でのナビゲーション計測に必要なフック
// Sentryがルーター遷移を自動的にキャプチャしてパフォーマンス監視に利用
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
