// =============================================================================
// Drizzle ORM スキーマ定義（PlanetScale PostgreSQLスキーマへの型付け）
// =============================================================================
//
// このファイルは既存DBスキーマへの型付けであり、drizzle-kitによるmigration生成には
// 使用しない。`supabase/migrations` は歴史的なディレクトリ名を維持した共通DDL正本で、
// `scripts/db-migrate.js --provider=planetscale` がPlanetScaleへ適用する。
//
// 設計方針（実行時クエリの正確性 = 列名・PG 型・NULL 制約・デフォルト値 が唯一の品質基準）:
// - 列プロパティ名は DB 列名そのまま（snake_case）。既存コードが PostgREST の
//   snake_case 応答形状に依存しているため、select 結果をそのまま既存 JSON 形状として
//   使えるようにする（camelCase 変換はしない）。
// - timestamptz / timestamp 列は mode: 'string'。PostgREST が文字列を返す挙動と
//   互換にするため（Date 変換はアプリ層で行わない）。
// - numeric 列は mode: 'number'。PostgREST は JSON number を返すため。
// - bigint 列は mode: 'number'。対象列（バイト数・ポイント合計）は
//   Number.MAX_SAFE_INTEGER を実運用上超えないため。
// - jsonb 列は .$type<...>() で src/types/database.ts の対応 TS 型を指定。
// - NOT NULL / DEFAULT は migration の DDL に忠実（database.ts と食い違う場合は
//   DDL を正とする。相違点はファイル末尾のコメントブロックに列挙）。
// - 外部キー参照・インデックス・CHECK 制約は定義しない（実 DB 側が正であり、
//   クエリの型付けには不要。ファイルの肥大を避ける）。
// - GENERATED ALWAYS AS 列は .generatedAlwaysAs() で定義し、insert 対象外である
//   ことが型で分かるようにする。
// =============================================================================

import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type { Json } from '@/types/database'

// -----------------------------------------------------------------------------
// streamers（配信者）
// 根拠: 00001 初版, 00007 gacha_sound_*, 00009 chat_announcement_*,
//       00025 rarity_weights, 00035 show_unowned_*, 00042 raid_gacha_active_until,
//       00043 raid_gacha_draw_count, 00044 chat_announcement_multi_*,
//       00049 custom_rarities, 00061 channel_point_collection_name,
//       00062 card_pack_names, 00063 default_card_pack_name,
//       00065 rarity_weights_scope / pack_rarity_weights, 00066 gacha_sound_rules,
//       20260817100000 trade_enabled / cross_channel_trade_enabled (#722)
// -----------------------------------------------------------------------------
export const streamers = pgTable('streamers', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  twitch_user_id: text('twitch_user_id').notNull(),
  twitch_username: text('twitch_username').notNull(),
  twitch_display_name: text('twitch_display_name').notNull(),
  twitch_profile_image_url: text('twitch_profile_image_url'),
  channel_point_reward_id: text('channel_point_reward_id'),
  channel_point_reward_name: text('channel_point_reward_name'),
  // 00061: メイン報酬に紐付くカードパック名（NULL = 全カード対象）
  channel_point_collection_name: text('channel_point_collection_name'),
  // 00001: DDL に NOT NULL は無い（DEFAULT true のみ）
  is_active: boolean('is_active').default(true),
  // 00007
  gacha_sound_url: text('gacha_sound_url'),
  gacha_sound_enabled: boolean('gacha_sound_enabled').notNull().default(false),
  // 00066: 複数ガチャ効果音ルール（全体・レアリティ別・報酬別）
  gacha_sound_rules: jsonb('gacha_sound_rules').$type<Json>().notNull().default(sql`'[]'::jsonb`),
  // 00009
  chat_announcement_enabled: boolean('chat_announcement_enabled').notNull().default(false),
  chat_announcement_template: text('chat_announcement_template'),
  // 00044
  chat_announcement_multi_template: text('chat_announcement_multi_template'),
  chat_announcement_multi_show_cards: boolean('chat_announcement_multi_show_cards').notNull().default(true),
  // 00025: レアリティ名をキーにした目標確率マップ（0-100）。NULL 許容
  rarity_weights: jsonb('rarity_weights').$type<Record<string, number>>().default(sql`NULL`),
  // 00065: 'global' | 'per_pack'（CHECK 制約は DB 側で担保）
  rarity_weights_scope: text('rarity_weights_scope').notNull().default('global'),
  // 00065: パック名（または __default__）をキーにしたレアリティ別確率マップの上書き
  pack_rarity_weights: jsonb('pack_rarity_weights')
    .$type<Record<string, Record<string, number>>>()
    .default(sql`NULL`),
  // 00049: DB 型は text[] ではなく JSONB の文字列配列（database.ts では string[]）
  custom_rarities: jsonb('custom_rarities').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // Issue #1783: カスタムレアリティごとの表示スタイル（色/グラデーション/グロー/エフェクト）。
  // キーはレアリティ名、値は RarityStyle オブジェクト。未設定時は空オブジェクト。
  rarity_styles: jsonb('rarity_styles').$type<Record<string, import('@/lib/rarity-styles').RarityStyle>>().notNull().default(sql`'{}'::jsonb`),
  // 00062: 同上、JSONB の文字列配列
  card_pack_names: jsonb('card_pack_names').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // 00063: デフォルト（未分類）パックの表示名オーバーライド
  default_card_pack_name: text('default_card_pack_name'),
  // 00035
  show_unowned_cards: boolean('show_unowned_cards').notNull().default(false),
  show_unowned_card_details: boolean('show_unowned_card_details').notNull().default(false),
  // 20260811000000: 配信掲載とランキング識別情報のオプトイン（両方OFF）
  publish_live_status: boolean('publish_live_status').notNull().default(false),
  publish_stats: boolean('publish_stats').notNull().default(false),
  // 20261015050000 (#934): 同志カードの名前つき視聴者ランキング公開オプトイン
  // （既定OFF・ユーザー向け設定UI無し。operator が明示的に有効化する）
  publish_card_ranking: boolean('publish_card_ranking').notNull().default(false),
  // 00042: デフォルト無し・NULL 許容
  raid_gacha_active_until: timestamp('raid_gacha_active_until', { withTimezone: true, mode: 'string' }),
  // 00043
  raid_gacha_draw_count: integer('raid_gacha_draw_count').notNull().default(0),
  // 20260817100000 (#722): トレード機能の配信者オプトイン（両方デフォルトOFF）
  trade_enabled: boolean('trade_enabled').notNull().default(false),
  cross_channel_trade_enabled: boolean('cross_channel_trade_enabled').notNull().default(false),
  // 20261014120000 (#1765 フォローアップ): アルバム表示の並び (N×N) を
  // コレクション(パック)ごとに指定する JSONB マップ。
  // キー: __all__（すべてのパック / 個別指定が無いパックの既定）,
  //       __default__（未分類のデフォルトパック）, または実パック名。
  // 値: 1ページの N（ALBUM_GRID_SIZE_MIN..MAX。CHECK 制約は DB 側で担保）
  pack_album_grid_sizes: jsonb('pack_album_grid_sizes')
    .$type<Record<string, number>>()
    .default(sql`NULL`),
  // 20261014120000 (#1765 フォローアップ): コレクションページの初期表示。
  // 'grid'（従来のカード一覧、既定）| 'album'（アルバムで開く）
  collection_default_view: text('collection_default_view').notNull().default('grid'),
  // 20261015120000 (#1782): 被りカードの「所有枚数に応じた表示段階」のしきい値。
  // レアリティ名 → 厳密増加する所有枚数の配列（1..3 要素）。
  //   例: {"legendary": [2, 5]} = 2枚で1段階・5枚で2段階。
  // エントリが無いレアリティ／NULL（既定）は段階表示をしない（＝機能OFF）。
  // CHECK 制約は DB 側、アプリ側の検証は src/lib/duplicate-display-tiers.ts。
  duplicate_display_tiers: jsonb('duplicate_display_tiers')
    .$type<Record<string, number[]>>()
    .default(sql`NULL`),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// cards（カード）
// 根拠: 00001 初版, 00002 バトルステータス列追加, 00014 rarity_order（生成カラム）,
//       00026 intra_rarity_weight, 00037 card_number, 00048 rarity の固定 CHECK 撤廃
//       （列型は不変）, 00061 collection_name, 00067 max_issuance_count
// -----------------------------------------------------------------------------
export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  streamer_id: uuid('streamer_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  image_url: text('image_url'),
  // #899: 余白（フィット）モードで焼き込んだ余白の色。NULL = 余白なし（従来のトリミング画像）。
  // 表示側は NULL なら object-cover、非 NULL なら object-contain + この色を背景にする。
  image_padding_color: text('image_padding_color'),
  // 00001: NOT NULL DEFAULT 'common'（00048 以降は任意のカスタムレアリティ文字列を許容）
  rarity: text('rarity').notNull().default('common'),
  // 00014: GENERATED ALWAYS AS ... STORED（insert / update 不可の生成カラム）。
  // PostgREST が CASE 式で ORDER BY できないため DB 側で階層順数値を持つ。
  rarity_order: smallint('rarity_order').generatedAlwaysAs(
    sql`CASE rarity WHEN 'legendary' THEN 1 WHEN 'epic' THEN 2 WHEN 'rare' THEN 3 WHEN 'common' THEN 4 ELSE 5 END`
  ),
  // 00001: DECIMAL(5,4) NOT NULL DEFAULT 0.25
  drop_rate: numeric('drop_rate', { precision: 5, scale: 4, mode: 'number' }).notNull().default(0.25),
  // 00026: NUMERIC NOT NULL DEFAULT 1.0（同レアリティ内の排出重み）
  intra_rarity_weight: numeric('intra_rarity_weight', { mode: 'number' }).notNull().default(1.0),
  // 00037: 図鑑番号の手動指定（NULL = アプリ側フォールバック採番）
  card_number: integer('card_number'),
  // 00067: 発行上限（NULL = 無制限）
  max_issuance_count: integer('max_issuance_count'),
  // 00061: 所属パック名（NULL = 未分類 = 全報酬の抽選対象）
  collection_name: text('collection_name'),
  // 00001: DDL に NOT NULL は無い（DEFAULT true のみ）
  is_active: boolean('is_active').default(true),
  // 00002: バトルステータス（いずれも DDL に NOT NULL は無い。DEFAULT のみ）
  hp: integer('hp').default(100),
  atk: integer('atk').default(30),
  def: integer('def').default(15),
  spd: integer('spd').default(5),
  skill_type: text('skill_type').default('attack'),
  skill_name: text('skill_name').default('通常攻撃'),
  skill_power: integer('skill_power').default(10),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  // NOTE: cards.trade_wantable（#1790, 20261014100000）は意図的にここへ定義しない。
  // 下の cardTradeSettings を参照。
})

/**
 * cards のトレード設定列だけを持つ狭い定義（#1790, 20261014100000_card_trade_wantable.sql）。
 *
 * trade_wantable = トレードの「求めるカード」に指定できるか（既定 true）。
 *
 * cards 本体に列を足さない理由: cards はガチャ・デモ・図鑑・カード管理
 * （getStreamerData / GET /api/cards / gacha/demo 等）で無指定 `.select()`、
 * カード作成で `.insert()`（values に無い列も `default` として列挙される）、
 * 更新で無指定 `.returning()` されている。本体に列を足すと、planetscale-migrate と
 * アプリデプロイが非同期なデプロイ窓（issue #788）でそれら全経路が 42703 になり、
 * ガチャ実経路まで止まる。列を使うのはトレード（src/lib/trade.ts）とカード管理の
 * 指定可否トグル（src/lib/card-trade-wantable.ts）だけなので、そこだけがこの定義を
 * 参照し、各所で列欠落時のフォールバックを持つ。
 *
 * 同じ物理テーブルを2つの pgTable で表すのは tradeOffersWithoutQuantity と同じ手法
 * （drizzle-kit による DDL 生成は使っておらず、DDL の正本は migration）。
 */
export const cardTradeSettings = pgTable('cards', {
  id: uuid('id').primaryKey(),
  streamer_id: uuid('streamer_id').notNull(),
  trade_wantable: boolean('trade_wantable').notNull().default(true),
})

// -----------------------------------------------------------------------------
// users（視聴者）
// 根拠: 00001 初版, 00004 Twitch トークン列, 00005 tos_accepted_at,
//       00009 twitch_scopes, 00023 twitch_sub_verified_at / twitch_has_sub
// -----------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  twitch_user_id: text('twitch_user_id').notNull(),
  twitch_username: text('twitch_username').notNull(),
  twitch_display_name: text('twitch_display_name').notNull(),
  twitch_profile_image_url: text('twitch_profile_image_url'),
  // 00004: DB には存在するが database.ts の Row 型には公開されていない
  // （トークンを API 応答に露出させないアプリ層の判断。列自体は DROP されていない）
  twitch_access_token: text('twitch_access_token'),
  twitch_refresh_token: text('twitch_refresh_token'),
  twitch_token_expires_at: timestamp('twitch_token_expires_at', { withTimezone: true, mode: 'string' }),
  // 20260724190000: OAuth refreshのisolate間single-flightと期限切れleaderのfencing
  twitch_refresh_lease_id: uuid('twitch_refresh_lease_id'),
  twitch_refresh_lease_expires_at: timestamp('twitch_refresh_lease_expires_at', { withTimezone: true, mode: 'string' }),
  // 00005: 利用規約同意日時（NULL = 未同意）
  tos_accepted_at: timestamp('tos_accepted_at', { withTimezone: true, mode: 'string' }),
  // 00009: text[] DEFAULT '{}'（DDL に NOT NULL は無い）
  twitch_scopes: text('twitch_scopes').array().default(sql`'{}'::text[]`),
  // 00023
  twitch_sub_verified_at: timestamp('twitch_sub_verified_at', { withTimezone: true, mode: 'string' }),
  // 00023: DDL に NOT NULL は無い（DEFAULT FALSE のみ）
  twitch_has_sub: boolean('twitch_has_sub').default(false),
  // 20260723150000 (#788): 非Affiliate配信者向けChannel Points Capability判定・オプトイン
  channel_points_capability: text('channel_points_capability').notNull().default('unknown'),
  channel_points_capability_checked_at: timestamp('channel_points_capability_checked_at', { withTimezone: true, mode: 'string' }),
  channel_points_enabled: boolean('channel_points_enabled').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// user_cards（ユーザーの所有カード）
// 根拠: 00001 初版, 00010 で UNIQUE(user_id, card_id) を撤廃（複数枚所持を許可）
// -----------------------------------------------------------------------------
export const userCards = pgTable('user_cards', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  user_id: uuid('user_id').notNull(),
  card_id: uuid('card_id').notNull(),
  obtained_at: timestamp('obtained_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// gacha_history（ガチャ履歴）
// 根拠: 00001 初版, 00033 reward_cost 追加, 00070 reward_id 追加
// -----------------------------------------------------------------------------
export const gachaHistory = pgTable('gacha_history', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  // Twitch EventSub メッセージ ID（冪等性キー、UNIQUE・NULL 許容）
  event_id: text('event_id'),
  user_twitch_id: text('user_twitch_id').notNull(),
  user_twitch_username: text('user_twitch_username'),
  card_id: uuid('card_id').notNull(),
  streamer_id: uuid('streamer_id').notNull(),
  // 00033: チャネルポイント消費量（EventSub 経由以外は NULL）
  reward_cost: integer('reward_cost'),
  // 00070: 起点になった Twitch チャネルポイント報酬 ID（EventSub 経由以外は NULL）
  reward_id: text('reward_id'),
  redeemed_at: timestamp('redeemed_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// gacha_history_event_tombstones（削除された履歴の冪等性キー）
// 根拠: 20261027000000 gacha history event tombstones
// 視聴者が履歴を削除しても、再送・replay で同じ event のカードを再発行しないため、
// 削除時に trigger が event_id を残す。migration 未適用の窓では参照すると 42P01 になる。
// -----------------------------------------------------------------------------
export const gachaHistoryEventTombstones = pgTable('gacha_history_event_tombstones', {
  event_id: text('event_id').primaryKey(),
  streamer_id: uuid('streamer_id').notNull(),
  user_twitch_id: text('user_twitch_id').notNull(),
  card_id: uuid('card_id').notNull(),
  redeemed_at: timestamp('redeemed_at', { withTimezone: true, mode: 'string' }),
  deleted_at: timestamp('deleted_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
})

// -----------------------------------------------------------------------------
// streamer_chat_multi_delivery_settings（Issue #1549: N連チャット配送方式）
// 根拠: 20260912013000 paced multi draw chat
// -----------------------------------------------------------------------------
export const streamerChatMultiDeliverySettings = pgTable('streamer_chat_multi_delivery_settings', {
  streamer_id: uuid('streamer_id').primaryKey(),
  delivery_mode: text('delivery_mode').notNull().default('summary'),
  chunk_size: integer('chunk_size').notNull().default(3),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
})

// -----------------------------------------------------------------------------
// chat_notification_outbox（Issue #708: transactional chat outbox）
// Twitch API配送はat-least-once。processing leaseで通常の同時送信を防ぐが、
// Twitch送信成功後〜sent記録前の停止時だけは重複送信を許容する。
// 20260912013000でN連チャットの配送snapshot/cursor列を追加（Issue #1549）。
// -----------------------------------------------------------------------------
export const chatNotificationOutbox = pgTable('chat_notification_outbox', {
  id: uuid('id').primaryKey().default(sql`extensions.uuid_generate_v4()`),
  batch_id: text('batch_id').notNull(),
  payload_version: smallint('payload_version').notNull().default(1),
  payload: jsonb('payload').$type<Json>().notNull(),
  expected_draw_count: integer('expected_draw_count').notNull(),
  assembled_draw_count: integer('assembled_draw_count').notNull(),
  delivery_mode: text('delivery_mode').notNull().default('summary'),
  delivery_chunk_size: integer('delivery_chunk_size').notNull().default(3),
  delivery_cursor: integer('delivery_cursor').notNull().default(0),
  delivery_mode_resolved: boolean('delivery_mode_resolved').notNull().default(false),
  status: text('status').notNull().default('pending'),
  attempt_count: integer('attempt_count').notNull().default(0),
  next_attempt_at: timestamp('next_attempt_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  lease_id: uuid('lease_id'),
  lease_expires_at: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
  last_error: text('last_error'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  sent_at: timestamp('sent_at', { withTimezone: true, mode: 'string' }),
  dead_at: timestamp('dead_at', { withTimezone: true, mode: 'string' }),
  // 20260922100000で追加（Issue #1665）。continuation（正常な予算切れによる途中
  // 終了）とretry（一時障害）を区別し、continuationはattempt_countを消費しない。
  pending_kind: text('pending_kind').notNull().default('initial'),
  // 回収sweeperの二重enqueue防止用の短い予約期限。未予約行はNULL。
  wake_reserved_until: timestamp('wake_reserved_until', { withTimezone: true, mode: 'string' }),
})

// -----------------------------------------------------------------------------
// chat_channel_send_gate（Issue #1665: チャネル単位の送信間隔gate）
// 根拠: 20260922100000 chat_outbox_continuation_and_channel_gate
// summary/individual/chunkedのどの経路から送っても、また別outbox行・別Worker
// 実行にまたがっても、同じ配信者チャンネルへの外部送信間隔（既定1.6秒）を守る。
// -----------------------------------------------------------------------------
export const chatChannelSendGate = pgTable('chat_channel_send_gate', {
  broadcaster_twitch_user_id: text('broadcaster_twitch_user_id').primaryKey(),
  next_send_at: timestamp('next_send_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
})

// -----------------------------------------------------------------------------
// battles（対戦履歴）
// 根拠: 00002 初版, 00003 opponent_card_id の NOT NULL 撤廃 + opponent_card_data 追加
// -----------------------------------------------------------------------------
export const battles = pgTable('battles', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  user_id: uuid('user_id').notNull(),
  user_card_id: uuid('user_card_id').notNull(),
  // 00003: CPU 対戦（スナップショット保持）を許すため NULL 許容化
  opponent_card_id: uuid('opponent_card_id'),
  // 00003: 対戦時点の相手カードスナップショット
  opponent_card_data: jsonb('opponent_card_data').$type<Json>(),
  result: text('result').notNull(),
  // 00002: DDL に NOT NULL は無い（DEFAULT 0 のみ）
  turn_count: integer('turn_count').default(0),
  battle_log: jsonb('battle_log').$type<Json>(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// battle_stats（対戦統計）
// 根拠: 00002 初版
// -----------------------------------------------------------------------------
export const battleStats = pgTable('battle_stats', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  user_id: uuid('user_id').notNull(),
  // 以下は DDL に NOT NULL は無い（DEFAULT のみ。DB トリガーが常に値を入れる運用）
  total_battles: integer('total_battles').default(0),
  wins: integer('wins').default(0),
  losses: integer('losses').default(0),
  draws: integer('draws').default(0),
  // DECIMAL(5,2) DEFAULT 0
  win_rate: numeric('win_rate', { precision: 5, scale: 2, mode: 'number' }).default(0),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// storage_usage（ストレージ使用量。user_prefix = '_global_' はグローバル合計）
// 根拠: 00006 初版
// -----------------------------------------------------------------------------
export const storageUsage = pgTable('storage_usage', {
  user_prefix: varchar('user_prefix', { length: 8 }).primaryKey(),
  bytes_used: bigint('bytes_used', { mode: 'number' }).notNull().default(0),
  blob_count: integer('blob_count').notNull().default(0),
  // 00006: TIMESTAMP WITH TIME ZONE DEFAULT NOW()（NOT NULL は無い）
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// blob_files（個別ファイル情報。削除時のサイズ逆引き用）
// 根拠: 00006 初版
// -----------------------------------------------------------------------------
export const blobFiles = pgTable('blob_files', {
  // ファイルの公開 URL が主キー
  url: text('url').primaryKey(),
  user_prefix: varchar('user_prefix', { length: 8 }).notNull(),
  file_size: bigint('file_size', { mode: 'number' }).notNull(),
  // 'r2' | 'vercel'（CHECK 制約は DB 側で担保）
  storage_type: varchar('storage_type', { length: 10 }).notNull().default('r2'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// storage_reservations（保存前の容量予約。Issue #1907）
// 根拠: 20261023000000_storage_reservation_and_reconcile.sql
// -----------------------------------------------------------------------------
export const storageReservations = pgTable('storage_reservations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  user_prefix: varchar('user_prefix', { length: 8 }).notNull(),
  file_size: bigint('file_size', { mode: 'number' }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
})

// -----------------------------------------------------------------------------
// streamer_additional_gacha_rewards（追加のガチャ用チャネルポイント報酬）
// 根拠: 00008 初版, 00041 draw_count / is_raid_limited 追加, 00061 collection_name 追加
// -----------------------------------------------------------------------------
export const streamerAdditionalGachaRewards = pgTable('streamer_additional_gacha_rewards', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  streamer_id: uuid('streamer_id').notNull(),
  reward_id: text('reward_id').notNull(),
  reward_name: text('reward_name'),
  // 00041: N 連ガチャの排出数
  draw_count: integer('draw_count').notNull().default(1),
  // 00041: レイド限定報酬フラグ
  is_raid_limited: boolean('is_raid_limited').notNull().default(false),
  // 00061: この報酬に紐付くパック名（NULL = 全カード対象）
  collection_name: text('collection_name'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// errors（エラーログ。GitHub Issue 自動作成用）
// 根拠: 00012 初版
// -----------------------------------------------------------------------------
export const errors = pgTable('errors', {
  // このテーブルのみ初版から gen_random_uuid()（他の初期テーブルは uuid_generate_v4()）
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  error_type: varchar('error_type', { length: 50 }).notNull(),
  message: text('message').notNull(),
  stack_trace: text('stack_trace'),
  context: jsonb('context').$type<Json>().default(sql`'{}'::jsonb`),
  // 'production' | 'preview'
  environment: varchar('environment', { length: 20 }).default('production'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  github_issue_created: boolean('github_issue_created').default(false),
  github_issue_number: integer('github_issue_number'),
  github_issue_url: text('github_issue_url'),
})

// -----------------------------------------------------------------------------
// streamer_storage_bonus（ストレージ容量ボーナス）
// 根拠: 00013 初版
// -----------------------------------------------------------------------------
export const streamerStorageBonus = pgTable('streamer_storage_bonus', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  streamer_id: uuid('streamer_id').notNull(),
  amount_mb: integer('amount_mb').notNull(),
  type: text('type').notNull(),
  // UNIQUE 制約の NULL 問題回避のため NOT NULL DEFAULT ''
  memo: text('memo').notNull().default(''),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// announcements（お知らせ）
// 根拠: 00016 初版
// -----------------------------------------------------------------------------
export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  title: text('title').notNull(),
  body: text('body').notNull(),
  // 'info' | 'warning' | 'critical'（CHECK 制約は DB 側で担保）
  severity: text('severity').notNull().default('info'),
  is_published: boolean('is_published').notNull().default(false),
  published_at: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// announcement_reads（お知らせ既読管理）
// 根拠: 00016 初版
// -----------------------------------------------------------------------------
export const announcementReads = pgTable('announcement_reads', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  announcement_id: uuid('announcement_id').notNull(),
  // users テーブル未登録ユーザーも既読化できるよう FK なしの TEXT
  twitch_user_id: text('twitch_user_id').notNull(),
  read_at: timestamp('read_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// support_codes（支援プラン共有コードマスタ。コードは SHA-256 ハッシュで保存）
// 根拠: 00017 初版
// -----------------------------------------------------------------------------
export const supportCodes = pgTable('support_codes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  code_hash: text('code_hash').notNull(),
  // 'support' | 'patron'
  plan_type: text('plan_type').notNull(),
  // 'active' | 'rotating' | 'revoked'
  status: text('status').notNull().default('active'),
  // 00017: DDL に NOT NULL は無い（DEFAULT '' のみ。database.ts は non-null 扱い）
  memo: text('memo').default(''),
  activation_count: integer('activation_count').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
})

// -----------------------------------------------------------------------------
// user_licenses（ユーザーの支援プランライセンス）
// 根拠: 00017 初版
// -----------------------------------------------------------------------------
export const userLicenses = pgTable('user_licenses', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  twitch_user_id: text('twitch_user_id').notNull(),
  code_id: uuid('code_id').notNull(),
  // 'support' | 'patron'
  plan_type: text('plan_type').notNull(),
  // FANBOX ID の参考情報（不正検知用）
  fanbox_id: text('fanbox_id'),
  activated_at: timestamp('activated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
})

// -----------------------------------------------------------------------------
// support_inquiries（支援者限定問い合わせ）
// 根拠: 00019 初版, 00072 GitHub Issue 追跡カラム追加（Issue #633）
// -----------------------------------------------------------------------------
export const supportInquiries = pgTable('support_inquiries', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  twitch_user_id: text('twitch_user_id').notNull(),
  // 投稿時点の表示名スナップショット
  twitch_display_name: text('twitch_display_name').notNull(),
  // 'bug' | 'feature' | 'other'
  category: text('category').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  // 'open' | 'in_progress' | 'resolved' | 'closed'
  status: text('status').notNull().default('open'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  // Cron Worker (twica-error-reporter) による GitHub Issue 発行状況（00072）。
  // errors テーブルは DDL が単なる DEFAULT FALSE だが、support_inquiries の DDL は
  // NOT NULL DEFAULT FALSE のため notNull を付与する（eq.false ポーリングで NULL 漏れ防止）。
  github_issue_created: boolean('github_issue_created').notNull().default(false),
  github_issue_number: integer('github_issue_number'),
  github_issue_url: text('github_issue_url'),
})

// -----------------------------------------------------------------------------
// support_inquiry_messages（問い合わせへの後続メッセージ）
// 根拠: 00019 初版
// -----------------------------------------------------------------------------
export const supportInquiryMessages = pgTable('support_inquiry_messages', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  inquiry_id: uuid('inquiry_id').notNull(),
  // 'user' | 'admin'
  sender_type: text('sender_type').notNull(),
  // user: twitchUserId / admin: 'admin'
  sender_id: text('sender_id').notNull(),
  body: text('body').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// collection_completions（コレクションコンプリート達成記録）
// 根拠: 00030 初版, 00064 collection_name 追加（パック別コンプリート）
// -----------------------------------------------------------------------------
export const collectionCompletions = pgTable('collection_completions', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  twitch_user_id: text('twitch_user_id').notNull(),
  streamer_id: uuid('streamer_id').notNull(),
  // 達成時点のアクティブカード総数
  total_cards: integer('total_cards').notNull(),
  // 00064: NULL = 全体コンプリート（従来レコード）、'__default__' = デフォルトパック
  collection_name: text('collection_name'),
  completed_at: timestamp('completed_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
})

// -----------------------------------------------------------------------------
// channel_point_usage_stats（チャネルポイント使用量の累積集計。gacha_history の
// トリガーで維持される）
// 根拠: 00039 でテーブル化（00036 は同名 RPC のみで、テーブル定義は 00039 が初出）
// -----------------------------------------------------------------------------
export const channelPointUsageStats = pgTable(
  'channel_point_usage_stats',
  {
    streamer_id: uuid('streamer_id').notNull(),
    user_twitch_id: text('user_twitch_id').notNull(),
    username: text('username'),
    total_points: bigint('total_points', { mode: 'number' }).notNull().default(0),
    redemption_count: integer('redemption_count').notNull().default(0),
    last_redeemed_at: timestamp('last_redeemed_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  },
  (table) => [
    // 00039: PRIMARY KEY (streamer_id, user_twitch_id)
    primaryKey({ columns: [table.streamer_id, table.user_twitch_id] }),
  ]
)

// -----------------------------------------------------------------------------
// twitch_bot_accounts（チャット通知送信用 Twitch BOT アカウント）
// 根拠: 00040 初版
// -----------------------------------------------------------------------------
export const twitchBotAccounts = pgTable('twitch_bot_accounts', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  // 'streamer' | 'system'
  owner_type: text('owner_type').notNull(),
  // owner_type = 'system' の場合は NULL（CHECK 制約は DB 側で担保）
  streamer_id: uuid('streamer_id'),
  twitch_user_id: text('twitch_user_id').notNull(),
  twitch_username: text('twitch_username'),
  twitch_display_name: text('twitch_display_name'),
  twitch_access_token: text('twitch_access_token').notNull(),
  twitch_refresh_token: text('twitch_refresh_token').notNull(),
  twitch_token_expires_at: timestamp('twitch_token_expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  // 20260724190000: OAuth refreshのisolate間single-flightと期限切れleaderのfencing
  twitch_refresh_lease_id: uuid('twitch_refresh_lease_id'),
  twitch_refresh_lease_expires_at: timestamp('twitch_refresh_lease_expires_at', { withTimezone: true, mode: 'string' }),
  // text[] DEFAULT '{}'（NOT NULL は無い）
  scopes: text('scopes').array().default(sql`'{}'::text[]`),
  // 'active' | 'revoked' | 'error'
  status: text('status').notNull().default('active'),
  last_error: text('last_error'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// streamer_chat_sender_settings（配信者ごとのチャット送信者設定）
// 根拠: 00040 初版
// -----------------------------------------------------------------------------
export const streamerChatSenderSettings = pgTable('streamer_chat_sender_settings', {
  // streamers.id がそのまま主キー（1 配信者 1 設定）
  streamer_id: uuid('streamer_id').primaryKey(),
  // 'streamer' | 'custom_bot' | 'official_bot'
  sender_mode: text('sender_mode').notNull().default('streamer'),
  custom_bot_account_id: uuid('custom_bot_account_id'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// card_owner_stats（カード別所持ユーザーの累積集計。user_cards のトリガーで維持）
// 根拠: 00051 初版
// -----------------------------------------------------------------------------
export const cardOwnerStats = pgTable(
  'card_owner_stats',
  {
    streamer_id: uuid('streamer_id').notNull(),
    card_id: uuid('card_id').notNull(),
    user_twitch_id: text('user_twitch_id').notNull(),
    username: text('username'),
    display_name: text('display_name'),
    owned_count: integer('owned_count').notNull().default(0),
    last_obtained_at: timestamp('last_obtained_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  },
  (table) => [
    // 00051: PRIMARY KEY (streamer_id, card_id, user_twitch_id)
    primaryKey({ columns: [table.streamer_id, table.card_id, table.user_twitch_id] }),
  ]
)

// -----------------------------------------------------------------------------
// card_stone_balances（カードストーン残高。ユーザー × 配信者ごとに 1 行）
// 根拠: 00059 初版
// -----------------------------------------------------------------------------
export const cardStoneBalances = pgTable('card_stone_balances', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  user_id: uuid('user_id').notNull(),
  streamer_id: uuid('streamer_id').notNull(),
  balance: integer('balance').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// card_stone_transactions（カードストーン取引履歴）
// 根拠: 00059 初版, 00060 request_id（冪等性キー）追加
// -----------------------------------------------------------------------------
export const cardStoneTransactions = pgTable('card_stone_transactions', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  user_id: uuid('user_id').notNull(),
  streamer_id: uuid('streamer_id').notNull(),
  // ON DELETE SET NULL のため NULL 許容
  card_id: uuid('card_id'),
  // 交換で削除された user_cards.id の記録（FK なし）
  user_card_id: uuid('user_card_id'),
  amount: integer('amount').notNull(),
  // 現状 'duplicate_exchange' のみ（CHECK 制約は DB 側で担保）
  type: text('type').notNull(),
  // 00060: クライアント生成の冪等性キー（旧レコードは NULL）
  request_id: uuid('request_id'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`now()`),
})

// -----------------------------------------------------------------------------
// trade_offers（カードトレードのオープンオファー。completed 行がそのまま履歴になる）
// 根拠: 20260817100000 初版（Issue #722, #715 子2）、20261011120000（#1789 wanted_quantity）
// -----------------------------------------------------------------------------
// 列定義はファクトリで共有する。Drizzle の pgTable は列ビルダーからテーブルごとに列
// オブジェクトを生成するため、同じビルダーを2つのテーブルへ渡さず、呼び出しごとに新しい
// ビルダーを作る。
const tradeOfferBaseColumns = () => ({
  id: uuid('id').primaryKey().default(sql`extensions.uuid_generate_v4()`),
  offerer_user_id: uuid('offerer_user_id').notNull(),
  // 意図的に FK なし（migration のコメント参照。user_cards 行はカードストーン交換で
  // DELETE されうるため、FK CASCADE にすると completed 行=履歴が消えてしまう）
  offered_user_card_id: uuid('offered_user_card_id').notNull(),
  // ON DELETE SET NULL のため NULL 許容（カード定義削除後は snapshot 側で表示）
  offered_card_id: uuid('offered_card_id'),
  offered_streamer_id: uuid('offered_streamer_id').notNull(),
  wanted_card_id: uuid('wanted_card_id'),
  wanted_streamer_id: uuid('wanted_streamer_id').notNull(),
  offered_card_snapshot: jsonb('offered_card_snapshot').$type<Json>().notNull(),
  wanted_card_snapshot: jsonb('wanted_card_snapshot').$type<Json>().notNull(),
  // GENERATED ALWAYS AS (offered_streamer_id <> wanted_streamer_id) STORED。insert / update 不可
  is_cross_channel: boolean('is_cross_channel').generatedAlwaysAs(
    sql`offered_streamer_id <> wanted_streamer_id`
  ),
  // 'open' | 'completed' | 'cancelled'（CHECK 制約は DB 側で担保）
  status: text('status').notNull().default('open'),
  accepted_by_user_id: uuid('accepted_by_user_id'),
  // FK なし（所有権移転後も成立時点の記録として残す）
  accepted_user_card_id: uuid('accepted_user_card_id'),
  completed_at: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  // 冪等性キー: 作成用（request_id）と応諾用（accepted_request_id）を分離
  request_id: uuid('request_id'),
  accepted_request_id: uuid('accepted_request_id'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
})

export const tradeOffers = pgTable('trade_offers', {
  ...tradeOfferBaseColumns(),
  // #1789: 応諾者が渡す wanted_card_id のコピー枚数（1〜10。CHECK は DB 側で担保）
  wanted_quantity: smallint('wanted_quantity').notNull().default(1),
})

/**
 * 20261011120000 適用前の trade_offers（wanted_quantity 列なし）。
 *
 * デプロイ窓（planetscale-migrate とアプリデプロイが非同期、issue #788）専用。
 * Drizzle の INSERT は values に無い列も `default` として列挙し、無指定の
 * `.select()` / `.returning()` も schema の全列を要求するため、列が未作成の DB では
 * tradeOffers を使う文がすべて 42703 で失敗する。src/lib/trade.ts はその場合だけ
 * この定義で再試行する。migration 適用後は到達しない死に分岐になるので、本番・preview
 * 双方の適用を確認したら tradeOffers に一本化して削除してよい。
 */
export const tradeOffersWithoutQuantity = pgTable('trade_offers', tradeOfferBaseColumns())

// -----------------------------------------------------------------------------
// trade_auctions / trade_auction_bids / trade_auction_bid_items（オークション形式の出品）
// 根拠: 20261018030000_trade_auctions.sql（Issue #1791）
// 書き込みはすべて同 migration の RPC（create/place/withdraw/cancel/settle）が行う。
// アプリはこれらの定義を一覧・詳細の読み取りにだけ使う（src/lib/trade-auction.ts）。
// migration 未適用の窓では参照すると 42P01 になるため、オークション API は 503 を返し、
// 既存トレードの拘束判定は src/lib/trade.ts で「オークション拘束なし」へ縮退する。
// -----------------------------------------------------------------------------
export const tradeAuctions = pgTable('trade_auctions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  seller_user_id: uuid('seller_user_id').notNull(),
  // 意図的に FK なし（trade_offers.offered_user_card_id と同じ理由）
  offered_user_card_id: uuid('offered_user_card_id').notNull(),
  // ON DELETE SET NULL のため NULL 許容
  offered_card_id: uuid('offered_card_id'),
  offered_streamer_id: uuid('offered_streamer_id').notNull(),
  offered_card_snapshot: jsonb('offered_card_snapshot').$type<Json>().notNull(),
  ends_at: timestamp('ends_at', { withTimezone: true, mode: 'string' }).notNull(),
  selection_deadline: timestamp('selection_deadline', { withTimezone: true, mode: 'string' }).notNull(),
  // 'open' | 'completed' | 'cancelled' | 'expired'（CHECK 制約は DB 側で担保）
  status: text('status').notNull().default('open'),
  winning_bid_id: uuid('winning_bid_id'),
  request_id: uuid('request_id').notNull(),
  settle_request_id: uuid('settle_request_id'),
  completed_at: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
})

export const tradeAuctionBids = pgTable('trade_auction_bids', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  auction_id: uuid('auction_id').notNull(),
  bidder_user_id: uuid('bidder_user_id').notNull(),
  // ON DELETE SET NULL のため NULL 許容（表示はスナップショット）
  bid_card_id: uuid('bid_card_id'),
  bid_streamer_id: uuid('bid_streamer_id').notNull(),
  // 1〜10（CHECK は DB 側で担保）
  quantity: smallint('quantity').notNull(),
  bid_card_snapshot: jsonb('bid_card_snapshot').$type<Json>().notNull(),
  is_cross_channel: boolean('is_cross_channel').notNull(),
  // 'active' | 'withdrawn' | 'won' | 'lost'（CHECK 制約は DB 側で担保）
  status: text('status').notNull().default('active'),
  request_id: uuid('request_id').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().default(sql`now()`),
})

export const tradeAuctionBidItems = pgTable('trade_auction_bid_items', {
  bid_id: uuid('bid_id').notNull(),
  // 意図的に FK なし
  user_card_id: uuid('user_card_id').notNull(),
})

// =============================================================================
// database.ts（src/types/database.ts）と migrations（DDL）の食い違い一覧
// いずれも migration の DDL を正としてこのファイルへ反映済み。
//
// 1. DB に存在するが database.ts の Row 型に無い列:
//    - users.twitch_access_token / twitch_refresh_token / twitch_token_expires_at
//      （00004 で追加、DROP する migration は無い。トークンをアプリ層の型に露出
//      させない意図的な省略と思われるが、実 DB には存在するため定義した）
//    - cards.rarity_order（00014、GENERATED ALWAYS AS ... STORED。生成カラムで
//      insert / update 不可のため Row 型から省かれているが、select は可能）
//    - gacha_history.reward_id（00070 で追加。database.ts が未更新）
//
// 2. DB 型の相違:
//    - streamers.custom_rarities / card_pack_names は database.ts では string[] だが、
//      DB 型は text[] ではなく JSONB の文字列配列（00049 / 00062）。
//      jsonb().$type<string[]>() として実体に合わせた。
//
// 3. NULL 制約の相違（database.ts は non-null 扱いだが、DDL に NOT NULL が無く
//    DEFAULT のみの列。insert 時に DB 側で値が入るため実運用上 NULL はほぼ
//    発生しないが、DDL を正として .notNull() を付けていない）:
//    - streamers.is_active / created_at / updated_at
//    - users.twitch_scopes / twitch_has_sub / created_at / updated_at
//    - cards.is_active / hp / atk / def / spd / skill_type / skill_name /
//      skill_power / created_at / updated_at
//    - user_cards.obtained_at
//    - gacha_history.redeemed_at
//    - battles.turn_count / created_at
//    - battle_stats.total_battles / wins / losses / draws / win_rate / updated_at
//    - streamer_additional_gacha_rewards.created_at
//    - announcements.created_at / updated_at
//    - announcement_reads.read_at
//    - support_codes.memo
//    - streamer_storage_bonus.created_at
//    - twitch_bot_accounts.created_at / updated_at
//    - streamer_chat_sender_settings.created_at / updated_at
// =============================================================================

// #720: completion bonuses are outside the active collectible set.
export const packCompletionRewards = pgTable('pack_completion_rewards', {
  id: uuid('id').primaryKey().defaultRandom(),
  streamer_id: uuid('streamer_id').notNull(),
  collection_name: text('collection_name').notNull(),
  reward_card_id: uuid('reward_card_id').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
export const packCompletionRewardGrants = pgTable('pack_completion_reward_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  twitch_user_id: text('twitch_user_id').notNull(),
  streamer_id: uuid('streamer_id').notNull(),
  collection_name: text('collection_name').notNull(),
  reward_card_id: uuid('reward_card_id').notNull(),
  granted_at: timestamp('granted_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
