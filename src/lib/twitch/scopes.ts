// Twitch OAuth スコープ定義（クライアント/サーバー共通）
//
// このモジュールはサーバー専用の依存（env-validation 等）を持たないため、
// "use client" コンポーネントからも安全に import できる。
// 逆に言うと、このファイルに env や fetch、server-only API を import してはいけない。
//
// Twitch OAuth scope definitions shared between server and client.
//
// This module intentionally avoids any server-only dependencies (e.g. env
// validation, secrets access) so that it can be imported from `"use client"`
// components without triggering server-side module side effects in the browser.
// Do NOT import env, fetch wrappers, or any server-only API here.

// デフォルトスコープ（ログイン時に必ず付与される基本スコープ）
// 権限最小化: 初回ログインは本人確認に必要な最小スコープのみを要求する。
// チャネルポイント連携は配信者が有効化する瞬間に step-up 再認証で追加要求する。
// Default scopes that are always requested during login.
// Least privilege: only request the minimum needed for identity verification.
// Channel point scopes are requested via step-up re-auth when a streamer
// explicitly enables the channel-point integration.
export const AUTH_SCOPES = [
  'user:read:email',
].join(' ')

// 追加スコープ定義（オプション機能用、再認証で取得）
// Additional scopes for optional features, obtained via re-authentication
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
