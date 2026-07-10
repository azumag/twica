import {
  cards as cardsTable,
  streamers as streamersTable,
  userCards as userCardsTable,
} from '@/lib/db/schema'

/**
 * battle 系 API ルート（start / stats / [battleId]）が共通で必要とする
 * 「user_card:user_cards(..., card:cards(..., streamer:streamers(...)))」の
 * PostgREST 埋め込みを、pg 直結の flat な JOIN 列から再構成するための共有モジュール
 * (#663 のコードレビューで、ほぼ同一のロジック(20〜30行、列名・null判定まで酷似)が
 * 3ファイルに独立実装されていると複数のレビューエージェントが指摘したため切り出す)。
 *
 * null 判定の根拠(3ファイル共通。migration 00001/00002 準拠):
 * - user_cards の存在判定: user_cards.user_id は NOT NULL。
 *   null = leftJoin 不一致 = PostgREST の埋め込み null に対応
 *   (battles.user_card_id は NOT NULL + FK のため実運用では常に一致するが、
 *   既存コードの防御的分岐を活かすため再現する)。
 * - card の存在判定: cards.id は PK。
 * - streamer の存在判定: streamers.twitch_user_id は NOT NULL。
 *
 * 2 つの select 列セットを用意している理由(意図的な非統合。列名を無理に揃えると
 * 別の衝突を生むため、オプション引数化ではなく2バリアントに分けた):
 * - USER_CARD_EMBED_COLUMNS ('uc_' / 'card_' プレフィックス): battle/stats,
 *   battle/[battleId] が使う。これらは battles テーブル由来の列(id, result,
 *   created_at 等)や opponent_card 側の cards 別名列と同じ SELECT に同居するため、
 *   列名衝突を避けるプレフィックスを付けている。
 * - CARD_EMBED_COLUMNS_C_PREFIX ('c_' プレフィックス) + 呼び出し元(battle/start)
 *   独自の user_id/card_id: この route は battles を経由せず user_cards を直接
 *   クエリしており、トップレベル列に user_cards.card_id をそのまま 'card_id' として
 *   使っている。cards.id 側を 'card_' プレフィックスにすると衝突するため、
 *   既存の select 列名(テストの fixture もこの列名を前提にしている)を変えずに
 *   移行できる 'c_' プレフィックスのまま据え置く。
 * どちらも「cards の 11 列 + streamer.twitch_user_id」という中身は完全に同一のため、
 * null 判定・オブジェクト整形の実体ロジック(buildCardEmbedCore)は 1 箇所に集約し、
 * 列名の差異(プレフィックス)だけを呼び出し側で吸収する。
 */

/** buildCardEmbedCore への正規化済み入力(select 列名のプレフィックスを剥がした後の値) */
interface CardEmbedCoreFields {
  id: string | null
  name: string | null
  hp: number | null
  atk: number | null
  def: number | null
  spd: number | null
  skill_type: string | null
  skill_name: string | null
  skill_power: number | null
  image_url: string | null
  rarity: string | null
  streamerTwitchUserId: string | null
}

/**
 * cards + streamer 埋め込みの再構成ロジック本体 (#663)。
 * null 判定・オブジェクト整形は 3 ファイルで唯一この関数のみが行う
 * (toUserCardEmbed / toCardEmbedCPrefixed はどちらも列名変換のみ行い、
 * ここへ委譲する)。
 */
function buildCardEmbedCore(fields: CardEmbedCoreFields): Record<string, unknown> | null {
  if (fields.id === null) {
    return null
  }
  return {
    id: fields.id,
    name: fields.name,
    hp: fields.hp,
    atk: fields.atk,
    def: fields.def,
    spd: fields.spd,
    skill_type: fields.skill_type,
    skill_name: fields.skill_name,
    skill_power: fields.skill_power,
    image_url: fields.image_url,
    rarity: fields.rarity,
    streamer:
      fields.streamerTwitchUserId === null
        ? null
        : { twitch_user_id: fields.streamerTwitchUserId },
  }
}

// ---------------------------------------------------------------------------
// battle/stats, battle/[battleId] 用: battles 由来の列と同居させるための
// 'uc_'/'card_' プレフィックス
// ---------------------------------------------------------------------------

/**
 * PostgREST の USER_CARD_SELECT 埋め込み(user_card:user_cards(user_id, card_id,
 * obtained_at, card:cards(..., streamer:streamers(twitch_user_id)))) を Drizzle の
 * flat な JOIN 列で再現するための select マップ (#663)。
 * battle/stats route の recentBattles/cardStats、battle/[battleId] route の
 * 単一クエリの 3 箇所で完全に同一の埋め込みを使うため共通化する。
 */
export const USER_CARD_EMBED_COLUMNS = {
  uc_user_id: userCardsTable.user_id,
  uc_card_id: userCardsTable.card_id,
  uc_obtained_at: userCardsTable.obtained_at,
  card_id: cardsTable.id,
  card_name: cardsTable.name,
  card_hp: cardsTable.hp,
  card_atk: cardsTable.atk,
  card_def: cardsTable.def,
  card_spd: cardsTable.spd,
  card_skill_type: cardsTable.skill_type,
  card_skill_name: cardsTable.skill_name,
  card_skill_power: cardsTable.skill_power,
  card_image_url: cardsTable.image_url,
  card_rarity: cardsTable.rarity,
  streamer_twitch_user_id: streamersTable.twitch_user_id,
}

/** USER_CARD_EMBED_COLUMNS を select した flat 行(leftJoin 不一致行は全て null) */
export interface UserCardEmbedFlatRow {
  uc_user_id: string | null
  uc_card_id: string | null
  uc_obtained_at: string | null
  card_id: string | null
  card_name: string | null
  card_hp: number | null
  card_atk: number | null
  card_def: number | null
  card_spd: number | null
  card_skill_type: string | null
  card_skill_name: string | null
  card_skill_power: number | null
  card_image_url: string | null
  card_rarity: string | null
  streamer_twitch_user_id: string | null
}

/**
 * flat な JOIN 行から PostgREST の user_card 埋め込みと同一の実行時形状
 * (多対一の埋め込みは「オブジェクトまたは null」)を再構成する (#663)。
 * battle/stats, battle/[battleId] の両方で使う(元は battle/stats route の
 * ローカル関数 toUserCardEmbed だったものをここへ集約)。
 *
 * null 判定の根拠はファイル冒頭コメント参照。
 */
export function toUserCardEmbed(row: UserCardEmbedFlatRow): Record<string, unknown> | null {
  if (row.uc_user_id === null) {
    return null
  }
  return {
    user_id: row.uc_user_id,
    card_id: row.uc_card_id,
    // obtained_at は両ルートの応答で未消費だが、PostgREST 埋め込みの形状パリティ
    // のために保持する(値は PG テキスト形式の生文字列のまま埋める)
    obtained_at: row.uc_obtained_at,
    card: buildCardEmbedCore({
      id: row.card_id,
      name: row.card_name,
      hp: row.card_hp,
      atk: row.card_atk,
      def: row.card_def,
      spd: row.card_spd,
      skill_type: row.card_skill_type,
      skill_name: row.card_skill_name,
      skill_power: row.card_skill_power,
      image_url: row.card_image_url,
      rarity: row.card_rarity,
      streamerTwitchUserId: row.streamer_twitch_user_id,
    }),
  }
}

// ---------------------------------------------------------------------------
// battle/start 用: user_cards を直接クエリするため 'c_' プレフィックス
// (トップレベルで user_cards.card_id を 'card_id' として使うため、cards.id 側を
// 'card_' にすると衝突する。既存の select 列名を変えずに移行するための据え置き)
// ---------------------------------------------------------------------------

/** cards + streamer 埋め込みの select 列('c_' プレフィックス版、battle/start 専用) */
export const CARD_EMBED_COLUMNS_C_PREFIX = {
  c_id: cardsTable.id,
  c_name: cardsTable.name,
  c_hp: cardsTable.hp,
  c_atk: cardsTable.atk,
  c_def: cardsTable.def,
  c_spd: cardsTable.spd,
  c_skill_type: cardsTable.skill_type,
  c_skill_name: cardsTable.skill_name,
  c_skill_power: cardsTable.skill_power,
  c_image_url: cardsTable.image_url,
  c_rarity: cardsTable.rarity,
  streamer_twitch_user_id: streamersTable.twitch_user_id,
}

/** CARD_EMBED_COLUMNS_C_PREFIX を select した flat 行のうち、当該部分の型 */
export interface CardEmbedCPrefixFlatRow {
  c_id: string | null
  c_name: string | null
  c_hp: number | null
  c_atk: number | null
  c_def: number | null
  c_spd: number | null
  c_skill_type: string | null
  c_skill_name: string | null
  c_skill_power: number | null
  c_image_url: string | null
  c_rarity: string | null
  streamer_twitch_user_id: string | null
}

/**
 * flat な JOIN 行から card:cards(...streamer:streamers(...)) 埋め込みを再構成する
 * (#663)。battle/start 用('c_' プレフィックス版)。null 判定根拠・整形ロジックは
 * toUserCardEmbed と共通(buildCardEmbedCore に集約済み)。
 */
export function toCardEmbedCPrefixed(row: CardEmbedCPrefixFlatRow): Record<string, unknown> | null {
  return buildCardEmbedCore({
    id: row.c_id,
    name: row.c_name,
    hp: row.c_hp,
    atk: row.c_atk,
    def: row.c_def,
    spd: row.c_spd,
    skill_type: row.c_skill_type,
    skill_name: row.c_skill_name,
    skill_power: row.c_skill_power,
    image_url: row.c_image_url,
    rarity: row.c_rarity,
    streamerTwitchUserId: row.streamer_twitch_user_id,
  })
}
