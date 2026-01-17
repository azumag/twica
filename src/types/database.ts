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
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          twitch_user_id: string
          twitch_username: string
          twitch_display_name: string
          twitch_profile_image_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          twitch_user_id?: string
          twitch_username?: string
          twitch_display_name?: string
          twitch_profile_image_url?: string | null
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

// Helper types
export type Streamer = Database['public']['Tables']['streamers']['Row']
export type Card = Database['public']['Tables']['cards']['Row']
export type User = Database['public']['Tables']['users']['Row']
export type UserCard = Database['public']['Tables']['user_cards']['Row']
export type GachaHistory = Database['public']['Tables']['gacha_history']['Row']
export type Battle = Database['public']['Tables']['battles']['Row'] & {
  opponent_card_data?: OpponentCardData | null
}
export type BattleStats = Database['public']['Tables']['battle_stats']['Row']

// Extended types with relations
export type CardWithStreamer = Card & {
  streamer: Streamer
}

// Types for Supabase query with streamer relation
export type StreamerRelation = {
  twitch_user_id: string
}

export type CardWithStreamerRelation = {
  id: string
  streamer_id: string
  streamers: StreamerRelation | StreamerRelation[]
}

// Type guard function for extracting Twitch user ID from streamers relation
export function extractTwitchUserId(streamers: unknown): string | null {
  if (!streamers) return null;

  if (Array.isArray(streamers)) {
    return streamers[0]?.twitch_user_id ?? null;
  }

  if (typeof streamers === 'object' && 'twitch_user_id' in streamers) {
    return (streamers as { twitch_user_id: string }).twitch_user_id;
  }

  return null;
}

export type UserCardWithDetails = UserCard & {
  card: CardWithStreamer
}

export type BattleWithDetails = Battle & {
  user_card: UserCardWithDetails
  opponent_card: CardWithStreamer
}

// Battle related types
export interface BattleLog {
  turn: number
  actor: 'user' | 'opponent'
  action: 'attack' | 'skill'
  damage?: number
  heal?: number
  message: string
}

export interface OpponentCardData {
  id: string
  name: string
  hp: number
  atk: number
  def: number
  spd: number
  skill_type: 'attack' | 'defense' | 'heal' | 'special'
  skill_name: string
  image_url: string
  rarity: 'common' | 'rare' | 'epic' | 'legendary'
}

export interface BattleCard {
  id: string
  name: string
  hp: number
  currentHp: number
  atk: number
  def: number
  spd: number
  skill_type: SkillType
  skill_name: string
  skill_power: number
  image_url?: string | null
  rarity?: Rarity
}

export interface BattleResultData {
  result: BattleResult
  turnCount: number
  userHp: number
  opponentHp: number
  logs: BattleLog[]
}

export interface SkillResult {
  damage?: number
  heal?: number
  defenseUp?: number
  message: string
}
