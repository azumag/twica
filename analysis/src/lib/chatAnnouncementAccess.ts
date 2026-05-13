export const CHAT_WRITE_SCOPE = 'user:write:chat'

export type ChatSenderMode = 'streamer' | 'custom_bot' | 'official_bot'
export type TwitchBotOwnerType = 'streamer' | 'system'
export type TwitchBotStatus = 'active' | 'revoked' | 'error'

export interface ChatAccessStreamerRow {
  id: string
  twitch_user_id: string
  chat_announcement_enabled: boolean
}

export interface ChatAccessUserScopeRow {
  twitch_user_id: string
  twitch_scopes: string[] | null
}

export interface ChatAccessSenderSettingRow {
  streamer_id: string
  sender_mode: ChatSenderMode
  custom_bot_account_id: string | null
}

export interface ChatAccessBotAccountRow {
  id: string
  owner_type: TwitchBotOwnerType
  streamer_id: string | null
  status: TwitchBotStatus
}

export interface StreamerChatAccess {
  streamer_id: string
  chat_announcement_enabled: boolean
  has_chat_scope: boolean
  sender_mode: ChatSenderMode
  has_active_bot_sender: boolean
  chat_send_available: boolean
}

export function buildStreamerChatAccessRows({
  streamers,
  userScopes,
  senderSettings,
  botAccounts,
}: {
  streamers: ChatAccessStreamerRow[]
  userScopes: ChatAccessUserScopeRow[]
  senderSettings: ChatAccessSenderSettingRow[]
  botAccounts: ChatAccessBotAccountRow[]
}): StreamerChatAccess[] {
  const scopesByTwitchId = new Map(
    userScopes.map((user) => [user.twitch_user_id, user.twitch_scopes || []])
  )
  const settingsByStreamerId = new Map(senderSettings.map((setting) => [setting.streamer_id, setting]))
  const botById = new Map(botAccounts.map((bot) => [bot.id, bot]))
  const hasActiveSystemBot = botAccounts.some(
    (bot) => bot.owner_type === 'system' && bot.status === 'active'
  )

  return streamers.map((streamer) => {
    const scopes = scopesByTwitchId.get(streamer.twitch_user_id) || []
    const hasChatScope = scopes.includes(CHAT_WRITE_SCOPE)
    const setting = settingsByStreamerId.get(streamer.id)
    const senderMode = setting?.sender_mode || 'streamer'

    const customBot = setting?.custom_bot_account_id
      ? botById.get(setting.custom_bot_account_id)
      : null
    const hasActiveCustomBot = Boolean(
      customBot &&
        customBot.owner_type === 'streamer' &&
        customBot.streamer_id === streamer.id &&
        customBot.status === 'active'
    )
    const hasActiveBotSender =
      (senderMode === 'custom_bot' && hasActiveCustomBot) ||
      (senderMode === 'official_bot' && hasActiveSystemBot)

    return {
      streamer_id: streamer.id,
      chat_announcement_enabled: streamer.chat_announcement_enabled,
      has_chat_scope: hasChatScope,
      sender_mode: senderMode,
      has_active_bot_sender: hasActiveBotSender,
      chat_send_available: hasChatScope || hasActiveBotSender,
    }
  })
}
