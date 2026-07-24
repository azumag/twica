// Database types for Twica Dashboard
// analysis 側で独立して保守されている型定義（root の src/types/database.ts の複製ではない）。
// 両者はテーブル構成が既に乖離している（root には battles/battle_stats 等があるが analysis にはない、
// analysis には blob_files/storage_usage/support_inquiries 等があるが root にはない、等）。
// 変更する際は analysis 側が返すadmin API DTOとPlanetScaleスキーマを基準にすること。

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'
export type SkillType = 'attack' | 'defense' | 'heal' | 'special'

// UI向けDTOの正本。ブラウザへ返すフィールドだけを定義し、DB接続ライブラリ固有の
// スキーマ型から分離することでOAuthトークン等のサーバー専用列を誤って露出させない。
export type Streamer = {
  id: string
  twitch_user_id: string
  twitch_username: string
  twitch_display_name: string
  twitch_profile_image_url: string | null
  channel_point_reward_id: string | null
  channel_point_reward_name: string | null
  is_active: boolean
  // ガチャ効果音URL - R2に保存された音声ファイルのURL
  gacha_sound_url: string | null
  // ガチャ効果音の有効/無効フラグ
  gacha_sound_enabled: boolean
  // チャット通知の有効/無効フラグ（デフォルトはfalse、オプトイン方式）
  // Whether to post gacha results to Twitch chat (opt-in, default false)
  chat_announcement_enabled: boolean
  // チャット通知のカスタムテンプレート（nullの場合はデフォルトテンプレートを使用）
  // Custom message template for chat announcements (null uses default)
  chat_announcement_template: string | null
  created_at: string
  updated_at: string
}

export type Card = {
  id: string
  streamer_id: string
  name: string
  description: string | null
  image_url: string | null
  rarity: Rarity
  drop_rate: number
  is_active: boolean
  hp: number
  atk: number
  def: number
  spd: number
  skill_type: SkillType
  skill_name: string
  skill_power: number
  created_at: string
  updated_at: string
}

export type User = {
  id: string
  twitch_user_id: string
  twitch_username: string
  twitch_display_name: string
  twitch_profile_image_url: string | null
  // 利用規約同意日時 - NULLの場合は未同意
  // Terms of Service acceptance timestamp - NULL means not yet accepted
  tos_accepted_at: string | null
  // Twitch OAuthで付与されたスコープ一覧（PostgreSQL TEXT配列）
  // user:write:chat があればチャット通知の送信権限あり
  twitch_scopes: string[]
  created_at: string
  updated_at: string
}

export type GachaHistory = {
  id: string
  user_twitch_id: string
  user_twitch_username: string | null
  card_id: string
  streamer_id: string
  redeemed_at: string
}

// お知らせのDTO
export type Announcement = {
  id: string
  title: string
  body: string
  severity: 'info' | 'warning' | 'critical'
  is_published: boolean
  published_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

// 問い合わせAPIの接続ライブラリ非依存DTO。管理画面はPostgresの実装詳細ではなく、
// /__admin が返すこの公開フィールドだけに依存する。
export type InquiryCategory = 'bug' | 'feature' | 'other'
export type InquiryStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

export type SupportInquiry = {
  id: string
  twitch_user_id: string
  twitch_display_name: string
  category: InquiryCategory
  subject: string
  body: string
  status: InquiryStatus
  created_at: string
  updated_at: string
}

export type SupportInquiryMessage = {
  id: string
  inquiry_id: string
  sender_type: 'user' | 'admin'
  sender_id: string
  body: string
  created_at: string
}

// 支援コードとライセンスAPIの公開DTO。PlanTypeはsupport_codes /
// user_licensesの値であり、アプリ本体の実効プラン階層とは別概念。
export type SupportCodeStatus = 'active' | 'rotating' | 'revoked'
export type PlanType = 'support' | 'patron'

export type SupportCode = {
  id: string
  code_hash: string
  plan_type: PlanType
  status: SupportCodeStatus
  memo: string | null
  activation_count: number
  created_at: string
  updated_at: string
}

export type UserLicense = {
  id: string
  twitch_user_id: string
  code_id: string
  plan_type: PlanType
  fanbox_id: string | null
  activated_at: string
}
