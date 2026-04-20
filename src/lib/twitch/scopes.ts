// Twitch OAuth scope constants shared between server and client code.
// クライアントコンポーネントから import されるため、ここではサーバー専用 API
// (env 検証, fetch 経由のTwitch API 呼び出し等) に依存してはならない。
// Client components import this module, so it must NOT pull in any
// server-only dependency (env validation, Twitch API calls, etc.).
// 実際の OAuth URL 構築や token 交換ロジックは `./auth` 側に集約する。

// デフォルトスコープ（ログイン時に必ず付与される基本スコープ）
// 権限最小化: 初回ログインは本人確認に必要な最小スコープのみを要求する。
// チャネルポイント連携は配信者が有効化する瞬間に step-up 再認証で追加要求する。
// Least privilege: only request the minimum needed for identity verification.
export const AUTH_SCOPES = [
  'user:read:email',
].join(' ')

// 追加スコープ定義（オプション機能用、再認証で取得）
// Additional scopes for optional features, obtained via re-authentication.
export const ADDITIONAL_SCOPES = {
  // Twitchチャットへの書き込み権限（ガチャ結果のチャット通知に必要）
  // Permission to write to Twitch chat (required for gacha result announcements)
  CHAT_WRITE: 'user:write:chat',
  // Twitchサブスク確認権限（配信チャネルのサブスクを確認しプランを自動適用）
  // Permission to check Twitch subscriptions (auto-apply plan for channel subscribers)
  USER_READ_SUBSCRIPTIONS: 'user:read:subscriptions',
  // チャネルポイント報酬の読み取り権限（カスタム報酬一覧取得とEventSub受信に必要）
  // Read Channel Points custom rewards (needed to list rewards and receive EventSub).
  CHANNEL_READ_REDEMPTIONS: 'channel:read:redemptions',
  // チャネルポイント報酬の管理権限（カスタム報酬作成・更新に必要）
  // Manage Channel Points custom rewards (needed to create/update rewards).
  CHANNEL_MANAGE_REDEMPTIONS: 'channel:manage:redemptions',
} as const

// チャネルポイント連携を有効化するために必要な追加スコープのセット
// Scopes required to enable the Channel Points integration feature.
export const CHANNEL_POINT_SCOPES: readonly string[] = [
  ADDITIONAL_SCOPES.CHANNEL_READ_REDEMPTIONS,
  ADDITIONAL_SCOPES.CHANNEL_MANAGE_REDEMPTIONS,
]
