export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Rarity = string
export type SkillType = 'attack' | 'defense' | 'heal' | 'special'
export type BattleResult = 'win' | 'lose' | 'draw'
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
          // メイン報酬に紐付くカードパック名（NULL=全カード対象）。Issue #393
          // Card pack bound to the main channel-point reward (NULL = all cards)
          channel_point_collection_name: string | null
          is_active: boolean
          // ガチャ効果音URL - R2に保存された音声ファイルのURL
          gacha_sound_url: string | null
          // ガチャ効果音の有効/無効フラグ
          gacha_sound_enabled: boolean
          // 複数ガチャ効果音ルール（全体・レアリティ別・報酬別）
          gacha_sound_rules: Json
          // チャット通知の有効/無効フラグ（デフォルトはfalse、オプトイン方式）
          // Whether to post gacha results to Twitch chat (opt-in, default false)
          chat_announcement_enabled: boolean
          // チャット通知のカスタムテンプレート（nullの場合はデフォルトテンプレートを使用）
          // Custom message template for chat announcements (null uses default)
          chat_announcement_template: string | null
          // N連ガチャ向けチャット通知のカスタムテンプレート（nullの場合はN連デフォルト）
          // Custom template for multi-draw chat announcements (null uses multi-draw default)
          chat_announcement_multi_template: string | null
          // N連ガチャ通知に個別カード名一覧を含めるか
          // Whether multi-draw announcements include the individual card-name list
          chat_announcement_multi_show_cards: boolean
          // レアリティ名をキーにした目標確率マップ（0-100）
          // Dynamic rarity-to-target-percentage map (0-100)
          rarity_weights: Record<string, number> | null
          // rarity_weights を全パック共通(global)で使うか、パック別
          // (per_pack, pack_rarity_weights を優先)で使うか。Issue #578
          // Whether rarity_weights applies globally or per-pack overrides
          // (pack_rarity_weights) take precedence. Issue #578
          rarity_weights_scope: 'global' | 'per_pack'
          // パック名(またはデフォルトパック用の __default__)をキーにした
          // レアリティ別目標確率マップの上書き。エントリの無いパックは
          // rarity_weights を継承する（アプリ層の規約）。Issue #578
          // Per-pack override of the rarity-to-target-percentage map, keyed
          // by pack name (or __default__ for the unclassified pseudo-pack).
          // Packs without an entry inherit rarity_weights (app-layer
          // convention). Issue #578
          pack_rarity_weights: Record<string, Record<string, number>> | null
          // 配信者が定義したカスタムレアリティ名の一覧（rarity_weights とは独立）
          // List of streamer-defined custom rarity names (decoupled from rarity_weights)
          custom_rarities: string[]
          // 配信者が事前登録したカードパック名の一覧（Issue #393再設計）
          // Pre-defined card pack names the streamer manages (Issue #393 redesign)
          card_pack_names: string[]
          // 「デフォルト」(未分類, collection_name IS NULL)パックの表示名
          // オーバーライド。NULL の場合は汎用ラベル("デフォルト")を表示する。
          // Display-name override for the "default" (unclassified) pseudo-pack.
          // NULL falls back to a generic label ("デフォルト"). Issue #554.
          default_card_pack_name: string | null
          // 視聴者向けコレクションページで未所持カードを表示するか（オプトイン、デフォルトfalse）
          // Whether unowned cards are visible on the viewer collection page (opt-in, default false)
          show_unowned_cards: boolean
          // 未所持カード表示時に画像/説明まで公開するか（false=プレースホルダーのみ）
          // When unowned cards are shown, whether to reveal card image/description
          show_unowned_card_details: boolean
          // レイド限定ガチャを受け付ける期限（null/期限切れは不明状態としてブロック）
          // Until when raid-limited gacha rewards are accepted. Null/expired blocks them.
          raid_gacha_active_until: string | null
          // incoming raid 送信者に自動付与するガチャ回数（0=無効）
          // Number of gacha draws gifted to the raider on incoming raids. 0 disables gifts.
          raid_gacha_draw_count: number
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
          channel_point_collection_name?: string | null
          is_active?: boolean
          gacha_sound_url?: string | null
          gacha_sound_enabled?: boolean
          gacha_sound_rules?: Json
          chat_announcement_enabled?: boolean
          chat_announcement_template?: string | null
          chat_announcement_multi_template?: string | null
          chat_announcement_multi_show_cards?: boolean
          rarity_weights?: Record<string, number> | null
          rarity_weights_scope?: 'global' | 'per_pack'
          pack_rarity_weights?: Record<string, Record<string, number>> | null
          custom_rarities?: string[]
          card_pack_names?: string[]
          default_card_pack_name?: string | null
          show_unowned_cards?: boolean
          show_unowned_card_details?: boolean
          raid_gacha_active_until?: string | null
          raid_gacha_draw_count?: number
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
          channel_point_collection_name?: string | null
          is_active?: boolean
          gacha_sound_url?: string | null
          gacha_sound_enabled?: boolean
          gacha_sound_rules?: Json
          chat_announcement_enabled?: boolean
          chat_announcement_template?: string | null
          chat_announcement_multi_template?: string | null
          chat_announcement_multi_show_cards?: boolean
          rarity_weights?: Record<string, number> | null
          rarity_weights_scope?: 'global' | 'per_pack'
          pack_rarity_weights?: Record<string, Record<string, number>> | null
          custom_rarities?: string[]
          card_pack_names?: string[]
          default_card_pack_name?: string | null
          show_unowned_cards?: boolean
          show_unowned_card_details?: boolean
          raid_gacha_active_until?: string | null
          raid_gacha_draw_count?: number
          created_at?: string
          updated_at?: string
        }
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
      }
      cards: {
        Row: {
          id: string
          streamer_id: string
          name: string
          description: string | null
          image_url: string | null
          rarity: Rarity
          card_number: number | null
          max_issuance_count: number | null
          // 所属カードパック名（NULL=未分類=全カード抽選対象）。Issue #393
          // Pack this card belongs to (NULL = unclassified = drawable from any reward)
          collection_name: string | null
          drop_rate: number
          // レアリティ内重み: 同レアリティ内での排出確率配分（デフォルト1.0=均等）
          intra_rarity_weight: number
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
          card_number?: number | null
          max_issuance_count?: number | null
          collection_name?: string | null
          drop_rate?: number
          intra_rarity_weight?: number
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
          card_number?: number | null
          max_issuance_count?: number | null
          collection_name?: string | null
          drop_rate?: number
          intra_rarity_weight?: number
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
          // 付与されたTwitchスコープの配列（既存ユーザーは空配列）
          // Array of granted Twitch OAuth scopes (empty for existing users until re-auth)
          twitch_scopes: string[]
          // Twitch API によるサブスク確認のキャッシュ
          twitch_sub_verified_at: string | null
          twitch_has_sub: boolean
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
          twitch_sub_verified_at?: string | null
          twitch_has_sub?: boolean
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
          twitch_sub_verified_at?: string | null
          twitch_has_sub?: boolean
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
          event_id: string | null
          user_twitch_id: string
          user_twitch_username: string | null
          card_id: string
          streamer_id: string
          reward_cost: number | null
          redeemed_at: string
        }
        Insert: {
          id?: string
          event_id?: string | null
          user_twitch_id: string
          user_twitch_username?: string | null
          card_id: string
          streamer_id: string
          reward_cost?: number | null
          redeemed_at?: string
        }
        Update: {
          id?: string
          event_id?: string | null
          user_twitch_id?: string
          user_twitch_username?: string | null
          card_id?: string
          streamer_id?: string
          reward_cost?: number | null
          redeemed_at?: string
        }
      }
      channel_point_usage_stats: {
        Row: {
          streamer_id: string
          user_twitch_id: string
          username: string | null
          total_points: number
          redemption_count: number
          last_redeemed_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          streamer_id: string
          user_twitch_id: string
          username?: string | null
          total_points?: number
          redemption_count?: number
          last_redeemed_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          streamer_id?: string
          user_twitch_id?: string
          username?: string | null
          total_points?: number
          redemption_count?: number
          last_redeemed_at?: string | null
          created_at?: string
          updated_at?: string
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
      // Additional gacha rewards table for multiple channel point reward support
      // メイン報酬に加えて追加の報酬でもガチャをトリガーできるようにするテーブル
      streamer_additional_gacha_rewards: {
        Row: {
          id: string
          streamer_id: string
          reward_id: string
          reward_name: string | null
          draw_count: number
          is_raid_limited: boolean
          // 追加報酬に紐付くカードパック名（NULL=全カード対象）。Issue #393
          // Card pack bound to this additional reward (NULL = all cards)
          collection_name: string | null
          created_at: string
        }
        Insert: {
          id?: string
          streamer_id: string
          reward_id: string
          reward_name?: string | null
          draw_count?: number
          is_raid_limited?: boolean
          collection_name?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          streamer_id?: string
          reward_id?: string
          reward_name?: string | null
          draw_count?: number
          is_raid_limited?: boolean
          collection_name?: string | null
          created_at?: string
        }
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
      }
      // 支援プラン共有コードマスタ
      // コードはSHA-256ハッシュで保存、status でコードの有効状態を管理
      support_codes: {
        Row: {
          id: string
          code_hash: string
          plan_type: 'support' | 'patron'
          status: 'active' | 'rotating' | 'revoked'
          memo: string
          activation_count: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          code_hash: string
          plan_type: 'support' | 'patron'
          status?: 'active' | 'rotating' | 'revoked'
          memo?: string
          activation_count?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          code_hash?: string
          plan_type?: 'support' | 'patron'
          status?: 'active' | 'rotating' | 'revoked'
          memo?: string
          activation_count?: number
          created_at?: string
          updated_at?: string
        }
      }
      // ユーザーの支援プランライセンス
      // コードが有効な限りライセンスも有効（有効期限なし）
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
      }
      // コレクションコンプリート達成記録テーブル
      // 達成時点のtotal_cardsを記録し、カード追加後も過去コンプリートを表示可能にする
      collection_completions: {
        Row: {
          id: string
          twitch_user_id: string
          streamer_id: string
          total_cards: number
          // 達成対象パック。NULL=全体コンプリート(従来レコード)、
          // "__default__"(DEFAULT_PACK_SENTINEL)=デフォルト(未分類)パック。Issue #557
          // Which pack this completion is for. NULL = overall (legacy rows),
          // DEFAULT_PACK_SENTINEL = the default (unclassified) pseudo-pack.
          collection_name: string | null
          completed_at: string
        }
        Insert: {
          id?: string
          twitch_user_id: string
          streamer_id: string
          total_cards: number
          collection_name?: string | null
          completed_at?: string
        }
        Update: {
          id?: string
          twitch_user_id?: string
          streamer_id?: string
          total_cards?: number
          collection_name?: string | null
          completed_at?: string
        }
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
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_gacha_drop_stats: {
        Args: {
          p_streamer_id: string
          p_from_date: string
          p_limit_per_card?: number
        }
        Returns: Json
      }
      get_card_owner_stats: {
        Args: {
          p_streamer_id: string
          p_limit_per_card?: number
        }
        Returns: Json
      }
      get_channel_point_usage_stats: {
        Args: {
          p_streamer_id: string
          p_from_date?: string | null
          p_limit?: number
        }
        Returns: Json
      }
      // Issue #554: atomically renames an existing catalog pack and cascades
      // the new name across cards.collection_name /
      // streamers.channel_point_collection_name /
      // streamer_additional_gacha_rewards.collection_name for that streamer.
      // See supabase/migrations/00063_add_default_pack_name_and_rename.sql.
      rename_card_pack: {
        Args: {
          p_streamer_id: string
          p_old_name: string
          p_new_name: string
        }
        Returns: null
      }
    }
    Enums: {
      [_ in never]: never
    }
  }
}

// Helper types
export type Streamer = Database['public']['Tables']['streamers']['Row']
// Issue #542: issued_count is not a DB column — it's computed by GET /api/cards
// (COUNT of user_cards grouped by card_id) and attached only to cards that have
// max_issuance_count set. Unlimited cards omit the field entirely to avoid the
// extra join/response payload for the common case.
// issued_countはDBカラムではなく、GET /api/cardsが計算して付与するフィールド
// （user_cardsをcard_idでグルーピングしたCOUNT）。max_issuance_countが設定された
// カードのみに付与される。無制限カードでは不要なJOIN/レスポンス増を避けるため
// フィールド自体を省略する。
export type Card = Database['public']['Tables']['cards']['Row'] & {
  issued_count?: number
}
export type User = Database['public']['Tables']['users']['Row']
export type UserCard = Database['public']['Tables']['user_cards']['Row']
export type GachaHistory = Database['public']['Tables']['gacha_history']['Row']
// Helper type for additional gacha rewards
// 追加ガチャ報酬のヘルパー型
export type StreamerAdditionalGachaReward = Database['public']['Tables']['streamer_additional_gacha_rewards']['Row']
// ストレージボーナスのヘルパー型
export type StreamerStorageBonus = Database['public']['Tables']['streamer_storage_bonus']['Row']
// お知らせのヘルパー型
export type Announcement = Database['public']['Tables']['announcements']['Row']
export type AnnouncementRead = Database['public']['Tables']['announcement_reads']['Row']
// 支援プラン関連のヘルパー型
export type SupportCode = Database['public']['Tables']['support_codes']['Row']
export type UserLicense = Database['public']['Tables']['user_licenses']['Row']
export type { PlanType } from '@/lib/plan-constants'

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
