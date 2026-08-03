import 'server-only'

import { cache } from 'react'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { withDbRetry } from '@/lib/db/retry'
import {
  streamers as streamersTable,
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  twitchBotAccounts as twitchBotAccountsTable,
  users as usersTable,
} from '@/lib/db/schema'
import { logger } from '@/lib/logger.server'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'

export interface ChatDeliveryCapability {
  chatAnnouncementEnabled: boolean
  hasStoredScope: boolean
  hasActiveBot: boolean
  canSendChat: boolean
  needsAttention: boolean
}

interface ResolveChatDeliveryCapabilityInput {
  chatAnnouncementEnabled: boolean
  hasStoredScope: boolean
  hasActiveBot: boolean
}

/**
 * DB設定・保存scope・Botを1つの表示契約へ正規化する純関数。
 * dashboard共通layoutでは外部Twitch APIを呼ばず、actual tokenとの乖離確認は
 * 既存ChatAnnouncementSettingsのcheck-scope API（該当section訪問時）に限定する。
 */
export function resolveChatDeliveryCapability(
  input: ResolveChatDeliveryCapabilityInput,
): ChatDeliveryCapability {
  const canSendChat = input.hasActiveBot || input.hasStoredScope
  const needsAttention = input.chatAnnouncementEnabled && !canSendChat

  return {
    chatAnnouncementEnabled: input.chatAnnouncementEnabled,
    hasStoredScope: input.hasStoredScope,
    hasActiveBot: input.hasActiveBot,
    canSendChat,
    needsAttention,
  }
}

type ChatDeliverySettingsRow = {
  streamerId: string
  chatAnnouncementEnabled: boolean
  twitchScopes: string[] | null
  senderMode: string | null
  customBotAccountId: string | null
}

async function findChatDeliverySettings(
  broadcasterTwitchUserId: string,
): Promise<ChatDeliverySettingsRow | null> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb()
      return db
        .select({
          streamerId: streamersTable.id,
          chatAnnouncementEnabled: streamersTable.chat_announcement_enabled,
          twitchScopes: usersTable.twitch_scopes,
          senderMode: streamerChatSenderSettingsTable.sender_mode,
          customBotAccountId: streamerChatSenderSettingsTable.custom_bot_account_id,
        })
        .from(streamersTable)
        .leftJoin(usersTable, eq(usersTable.twitch_user_id, streamersTable.twitch_user_id))
        .leftJoin(
          streamerChatSenderSettingsTable,
          eq(streamerChatSenderSettingsTable.streamer_id, streamersTable.id),
        )
        .where(eq(streamersTable.twitch_user_id, broadcasterTwitchUserId))
        .limit(1)
    },
    'getChatDeliveryCapability(settings)',
    { idempotent: true },
  )
  return rows[0] ?? null
}

/**
 * 実送信のgetBotAccountForChat()と同じactive Bot選択条件を、credentialを読まずに
 * 再現する。ダッシュボード表示のためにtoken refreshやTwitch APIを起動すると、
 * 全ページロードが送信経路並みの高コスト処理になるため、存在確認に必要なidだけを
 * SELECTする。customは所有者/streamer/id/status、officialはsystem/statusを一致させる。
 */
async function hasActiveConfiguredBot(settings: ChatDeliverySettingsRow): Promise<boolean> {
  if (settings.senderMode === 'custom_bot' && settings.customBotAccountId) {
    // closure内でもnull除去を維持し、query条件が後から変更されても未設定IDを
    // 誤って比較しないよう、不変のローカル値へ固定する。
    const customBotAccountId = settings.customBotAccountId
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({ id: twitchBotAccountsTable.id })
          .from(twitchBotAccountsTable)
          .where(and(
            eq(twitchBotAccountsTable.id, customBotAccountId),
            eq(twitchBotAccountsTable.owner_type, 'streamer'),
            eq(twitchBotAccountsTable.streamer_id, settings.streamerId),
            eq(twitchBotAccountsTable.status, 'active'),
          ))
          .limit(1)
      },
      'getChatDeliveryCapability(custom bot)',
      { idempotent: true },
    )
    return Boolean(rows[0])
  }

  if (settings.senderMode === 'official_bot') {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({ id: twitchBotAccountsTable.id })
          .from(twitchBotAccountsTable)
          .where(and(
            eq(twitchBotAccountsTable.owner_type, 'system'),
            eq(twitchBotAccountsTable.status, 'active'),
          ))
          .limit(1)
      },
      'getChatDeliveryCapability(official bot)',
      { idempotent: true },
    )
    return Boolean(rows[0])
  }

  return false
}

async function getChatDeliveryCapabilityUncached(
  broadcasterTwitchUserId: string,
): Promise<ChatDeliveryCapability> {
  try {
    const settings = await findChatDeliverySettings(broadcasterTwitchUserId)
    if (!settings) {
      return resolveChatDeliveryCapability({
        chatAnnouncementEnabled: false,
        hasStoredScope: false,
        hasActiveBot: false,
      })
    }

    const hasStoredScope = Boolean(
      settings.twitchScopes?.includes(ADDITIONAL_SCOPES.CHAT_WRITE),
    )

    // 無効時は警告不要であり、active Botの追加DB照会も行わない。
    if (!settings.chatAnnouncementEnabled) {
      return resolveChatDeliveryCapability({
        chatAnnouncementEnabled: false,
        hasStoredScope,
        hasActiveBot: false,
      })
    }

    const hasActiveBot = await hasActiveConfiguredBot(settings)
    return resolveChatDeliveryCapability({
      chatAnnouncementEnabled: true,
      hasStoredScope,
      hasActiveBot,
    })
  } catch (error) {
    // 補助警告の判定失敗で全ダッシュボードを500にしない。確証のない送信不能を
    // 表示すると誤誘導になるため、このrequestではバナーを出さず構造化warnを残す。
    logger.warn('Failed to resolve chat delivery capability for dashboard', {
      broadcasterTwitchUserId,
      error: error instanceof Error ? error.message : String(error),
    })
    return resolveChatDeliveryCapability({
      chatAnnouncementEnabled: false,
      hasStoredScope: false,
      hasActiveBot: false,
    })
  }
}

/** request内でlayoutとsettings pageから同じ判定を呼んでもDB I/Oは1回。 */
export const getChatDeliveryCapability = cache(getChatDeliveryCapabilityUncached)
