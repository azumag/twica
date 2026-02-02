// Database types for Twica Dashboard
// Copied from the main application's src/types/database.ts for type safety
// This ensures consistency between the main app and the dashboard

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'
export type SkillType = 'attack' | 'defense' | 'heal' | 'special'
export type BattleResult = 'win' | 'lose' | 'draw'

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
      }
      battles: {
        Row: {
          id: string
          user_id: string
          user_card_id: string
          opponent_card_id: string | null
          opponent_card_data: Json | null
          result: BattleResult
          turn_count: number
          battle_log: Json | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          user_card_id: string
          opponent_card_id?: string | null
          opponent_card_data?: Json | null
          result: BattleResult
          turn_count?: number
          battle_log?: Json | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          user_card_id?: string
          opponent_card_id?: string | null
          opponent_card_data?: Json | null
          result?: BattleResult
          turn_count?: number
          battle_log?: Json | null
          created_at?: string
        }
      }
      battle_stats: {
        Row: {
          id: string
          user_id: string
          total_battles: number
          wins: number
          losses: number
          draws: number
          win_rate: number
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          total_battles?: number
          wins?: number
          losses?: number
          draws?: number
          win_rate?: number
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          total_battles?: number
          wins?: number
          losses?: number
          draws?: number
          win_rate?: number
          updated_at?: string
        }
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
export type UserCard = Database['public']['Tables']['user_cards']['Row']
export type GachaHistory = Database['public']['Tables']['gacha_history']['Row']
export type Battle = Database['public']['Tables']['battles']['Row']
export type BattleStats = Database['public']['Tables']['battle_stats']['Row']
export type BlobFile = Database['public']['Tables']['blob_files']['Row']

// Extended types with relations for dashboard views
export type CardWithStreamer = Card & {
  streamers: Streamer
}

export type UserWithStats = User & {
  card_count?: number
  battle_stats?: BattleStats | null
}

export type GachaHistoryWithDetails = GachaHistory & {
  cards: Card
  streamers: Streamer
}
