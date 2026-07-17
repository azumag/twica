// Database types for Twica Dashboard
// analysis 側で独立して保守されている型定義（root の src/types/database.ts の複製ではない）。
// 両者はテーブル構成が既に乖離している（root には battles/battle_stats 等があるが analysis にはない、
// analysis には blob_files/storage_usage/support_inquiries 等があるが root にはない、等）。
// 変更する際は analysis 側の実スキーマ（supabase/migrations/）を基準にすること。

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'
export type SkillType = 'attack' | 'defense' | 'heal' | 'special'
export type ChatSenderMode = 'streamer' | 'custom_bot' | 'official_bot'
export type TwitchBotOwnerType = 'streamer' | 'system'
export type TwitchBotStatus = 'active' | 'revoked' | 'error'

export interface Database {
  public: {
    Tables: {
      streamers: {
        Row: {
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
        Insert: {
          id?: string
          twitch_user_id: string
          twitch_username: string
          twitch_display_name: string
          twitch_profile_image_url?: string | null
          channel_point_reward_id?: string | null
          channel_point_reward_name?: string | null
          is_active?: boolean
          gacha_sound_url?: string | null
          gacha_sound_enabled?: boolean
          chat_announcement_enabled?: boolean
          chat_announcement_template?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          twitch_user_id?: string
          twitch_username?: string
          twitch_display_name?: string
          twitch_profile_image_url?: string | null
          channel_point_reward_id?: string | null
          channel_point_reward_name?: string | null
          is_active?: boolean
          gacha_sound_url?: string | null
          gacha_sound_enabled?: boolean
          chat_announcement_enabled?: boolean
          chat_announcement_template?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      cards: {
        Row: {
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
        Insert: {
          id?: string
          streamer_id: string
          name: string
          description?: string | null
          image_url?: string | null
          rarity?: Rarity
          drop_rate?: number
          is_active?: boolean
          hp?: number
          atk?: number
          def?: number
          spd?: number
          skill_type?: SkillType
          skill_name?: string
          skill_power?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          streamer_id?: string
          name?: string
          description?: string | null
          image_url?: string | null
          rarity?: Rarity
          drop_rate?: number
          is_active?: boolean
          hp?: number
          atk?: number
          def?: number
          spd?: number
          skill_type?: SkillType
          skill_name?: string
          skill_power?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      users: {
        Row: {
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
        Insert: {
          id?: string
          twitch_user_id: string
          twitch_username: string
          twitch_display_name: string
          twitch_profile_image_url?: string | null
          tos_accepted_at?: string | null
          twitch_scopes?: string[]
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          twitch_user_id?: string
          twitch_username?: string
          twitch_display_name?: string
          twitch_profile_image_url?: string | null
          tos_accepted_at?: string | null
          twitch_scopes?: string[]
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      // ユーザーの支援プランライセンス（コードが有効な限りライセンスも有効、有効期限なし）
      // supabase/migrations/00017_add_support_plans.sql で定義されたスキーマに準拠
      user_licenses: {
        Row: {
          id: string
          twitch_user_id: string
          code_id: string
          plan_type: 'support' | 'patron'
          fanbox_id: string | null
          activated_at: string
        }
        Insert: {
          id?: string
          twitch_user_id: string
          code_id: string
          plan_type: 'support' | 'patron'
          fanbox_id?: string | null
          activated_at?: string
        }
        Update: {
          id?: string
          twitch_user_id?: string
          code_id?: string
          plan_type?: 'support' | 'patron'
          fanbox_id?: string | null
          activated_at?: string
        }
        Relationships: []
      }
      twitch_bot_accounts: {
        Row: {
          id: string
          owner_type: TwitchBotOwnerType
          streamer_id: string | null
          twitch_user_id: string
          twitch_username: string | null
          twitch_display_name: string | null
          twitch_access_token: string
          twitch_refresh_token: string
          twitch_token_expires_at: string
          scopes: string[] | null
          status: TwitchBotStatus
          last_error: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          owner_type: TwitchBotOwnerType
          streamer_id?: string | null
          twitch_user_id: string
          twitch_username?: string | null
          twitch_display_name?: string | null
          twitch_access_token: string
          twitch_refresh_token: string
          twitch_token_expires_at: string
          scopes?: string[] | null
          status?: TwitchBotStatus
          last_error?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          owner_type?: TwitchBotOwnerType
          streamer_id?: string | null
          twitch_user_id?: string
          twitch_username?: string | null
          twitch_display_name?: string | null
          twitch_access_token?: string
          twitch_refresh_token?: string
          twitch_token_expires_at?: string
          scopes?: string[] | null
          status?: TwitchBotStatus
          last_error?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      streamer_chat_sender_settings: {
        Row: {
          streamer_id: string
          sender_mode: ChatSenderMode
          custom_bot_account_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          streamer_id: string
          sender_mode?: ChatSenderMode
          custom_bot_account_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          streamer_id?: string
          sender_mode?: ChatSenderMode
          custom_bot_account_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_cards: {
        Row: {
          id: string
          user_id: string
          card_id: string
          obtained_at: string
        }
        Insert: {
          id?: string
          user_id: string
          card_id: string
          obtained_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          card_id?: string
          obtained_at?: string
        }
        Relationships: []
      }
      gacha_history: {
        Row: {
          id: string
          user_twitch_id: string
          user_twitch_username: string | null
          card_id: string
          streamer_id: string
          redeemed_at: string
        }
        Insert: {
          id?: string
          user_twitch_id: string
          user_twitch_username?: string | null
          card_id: string
          streamer_id: string
          redeemed_at?: string
        }
        Update: {
          id?: string
          user_twitch_id?: string
          user_twitch_username?: string | null
          card_id?: string
          streamer_id?: string
          redeemed_at?: string
        }
        // card_id/streamer_idはINITIAL SCHEMA(00001)でREFERENCES指定のみ(制約名省略)のため、
        // Postgresのデフォルト命名規則 <table>_<column>_fkey が適用される。
        // getGachaChart()等の cards(...)/streamers(...) 埋め込みselectを解決するために必要
        Relationships: [
          {
            foreignKeyName: 'gacha_history_card_id_fkey'
            columns: ['card_id']
            referencedRelation: 'cards'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'gacha_history_streamer_id_fkey'
            columns: ['streamer_id']
            referencedRelation: 'streamers'
            referencedColumns: ['id']
          },
        ]
      }
      // ユーザーごとの集計済みストレージ使用量テーブル
      // recordBlobFile/removeBlobFileの呼び出し時にRPCで自動更新される
      // '_global_'はグローバル合計を表す特殊なuser_prefix
      storage_usage: {
        Row: {
          user_prefix: string
          bytes_used: number
          blob_count: number
          updated_at: string
        }
        Insert: {
          user_prefix: string
          bytes_used?: number
          blob_count?: number
          updated_at?: string
        }
        Update: {
          user_prefix?: string
          bytes_used?: number
          blob_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      // Storage tracking tables for monitoring blob file usage per user/streamer
      // blob_filesはカード画像のストレージ情報を管理し、URLをキーにファイルサイズを記録
      blob_files: {
        Row: {
          url: string
          user_prefix: string
          file_size: number
          storage_type: 'r2' | 'vercel'
          created_at: string
        }
        Insert: {
          url: string
          user_prefix: string
          file_size: number
          storage_type: 'r2' | 'vercel'
          created_at?: string
        }
        Update: {
          url?: string
          user_prefix?: string
          file_size?: number
          storage_type?: 'r2' | 'vercel'
          created_at?: string
        }
        Relationships: []
      }
      // お知らせテーブル - 管理者がユーザー向けに投稿するお知らせ
      announcements: {
        Row: {
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
        Insert: {
          id?: string
          title: string
          body: string
          severity?: 'info' | 'warning' | 'critical'
          is_published?: boolean
          published_at?: string | null
          expires_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          title?: string
          body?: string
          severity?: 'info' | 'warning' | 'critical'
          is_published?: boolean
          published_at?: string | null
          expires_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      // お知らせ既読管理テーブル - ユーザーごとの既読状態を追跡
      announcement_reads: {
        Row: {
          id: string
          announcement_id: string
          twitch_user_id: string
          read_at: string
        }
        Insert: {
          id?: string
          announcement_id: string
          twitch_user_id: string
          read_at?: string
        }
        Update: {
          id?: string
          announcement_id?: string
          twitch_user_id?: string
          read_at?: string
        }
        Relationships: [{
          foreignKeyName: 'announcement_reads_announcement_id_fkey'
          columns: ['announcement_id']
          referencedRelation: 'announcements'
          referencedColumns: ['id']
        }]
      }
      // ストリーマーごとのストレージ容量ボーナステーブル
      // キャンペーンやプロモーション等で追加容量を付与するために使用
      streamer_storage_bonus: {
        Row: {
          id: string
          streamer_id: string
          amount_mb: number
          type: string
          memo: string
          created_at: string
        }
        Insert: {
          id?: string
          streamer_id: string
          amount_mb: number
          type: string
          memo?: string
          created_at?: string
        }
        Update: {
          id?: string
          streamer_id?: string
          amount_mb?: number
          type?: string
          memo?: string
          created_at?: string
        }
        Relationships: []
      }
      // 問い合わせ本体テーブル - 支援者が投稿する問い合わせ
      support_inquiries: {
        Row: {
          id: string
          twitch_user_id: string
          twitch_display_name: string
          category: 'bug' | 'feature' | 'other'
          subject: string
          body: string
          status: 'open' | 'in_progress' | 'resolved' | 'closed'
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          twitch_user_id: string
          twitch_display_name: string
          category: 'bug' | 'feature' | 'other'
          subject: string
          body: string
          status?: 'open' | 'in_progress' | 'resolved' | 'closed'
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          twitch_user_id?: string
          twitch_display_name?: string
          category?: 'bug' | 'feature' | 'other'
          subject?: string
          body?: string
          status?: 'open' | 'in_progress' | 'resolved' | 'closed'
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      // 問い合わせメッセージテーブル - ユーザー/管理者の返信
      support_inquiry_messages: {
        Row: {
          id: string
          inquiry_id: string
          sender_type: 'user' | 'admin'
          sender_id: string
          body: string
          created_at: string
        }
        Insert: {
          id?: string
          inquiry_id: string
          sender_type: 'user' | 'admin'
          sender_id: string
          body: string
          created_at?: string
        }
        Update: {
          id?: string
          inquiry_id?: string
          sender_type?: 'user' | 'admin'
          sender_id?: string
          body?: string
          created_at?: string
        }
        Relationships: [{
          foreignKeyName: 'support_inquiry_messages_inquiry_id_fkey'
          columns: ['inquiry_id']
          referencedRelation: 'support_inquiries'
          referencedColumns: ['id']
        }]
      }
      // 支援コード（共有コードマスタ）。00017_add_support_plans.sqlで追加。
      // 分析ダッシュボード側の型定義に欠落していたため、実DBスキーマに合わせて追加
      support_codes: {
        Row: {
          id: string
          code_hash: string
          plan_type: 'support' | 'patron'
          status: 'active' | 'rotating' | 'revoked'
          memo: string | null
          activation_count: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          code_hash: string
          plan_type: 'support' | 'patron'
          status?: 'active' | 'rotating' | 'revoked'
          memo?: string | null
          activation_count?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          code_hash?: string
          plan_type?: 'support' | 'patron'
          status?: 'active' | 'rotating' | 'revoked'
          memo?: string | null
          activation_count?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
  }
}

// Helper types for easier usage
export type Streamer = Database['public']['Tables']['streamers']['Row']
export type Card = Database['public']['Tables']['cards']['Row']
export type User = Database['public']['Tables']['users']['Row']
export type GachaHistory = Database['public']['Tables']['gacha_history']['Row']
// お知らせのヘルパー型
export type Announcement = Database['public']['Tables']['announcements']['Row']

// 問い合わせカテゴリ
export type InquiryCategory = 'bug' | 'feature' | 'other'
// 問い合わせステータス
export type InquiryStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

// 問い合わせ本体
export interface SupportInquiry {
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

// 問い合わせメッセージ（ユーザー/管理者の返信）
export interface SupportInquiryMessage {
  id: string
  inquiry_id: string
  sender_type: 'user' | 'admin'
  sender_id: string
  body: string
  created_at: string
}

// 支援コードのステータス
export type SupportCodeStatus = 'active' | 'rotating' | 'revoked'
// 支援プランタイプ
// support_codes.plan_type / user_licenses.plan_type 列専用の値。
// root の src/lib/plan-constants.ts の PlanType（ユーザー実効プラン階層、'basic'|'support'|'patron'|'twitch_sub'を含む別概念）とは異なる。
export type PlanType = 'support' | 'patron'

// 支援コード（共有コードマスタ）
export interface SupportCode {
  id: string
  code_hash: string
  plan_type: PlanType
  status: SupportCodeStatus
  memo: string | null
  activation_count: number
  created_at: string
  updated_at: string
}

// ユーザーライセンス（コードアクティベーション記録）
export interface UserLicense {
  id: string
  twitch_user_id: string
  code_id: string
  plan_type: PlanType
  fanbox_id: string | null
  activated_at: string
}
