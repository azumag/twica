import { describe, expect, it } from 'vitest'

import { buildStreamerChatAccessRows } from '../../analysis/src/lib/chatAnnouncementAccess'

const streamers = [
  { id: 'streamer-with-scope', twitch_user_id: '1001', chat_announcement_enabled: true },
  { id: 'streamer-missing-scope', twitch_user_id: '1002', chat_announcement_enabled: true },
  { id: 'streamer-custom-bot', twitch_user_id: '1003', chat_announcement_enabled: true },
  { id: 'streamer-official-bot', twitch_user_id: '1004', chat_announcement_enabled: true },
  { id: 'streamer-no-settings', twitch_user_id: '1005', chat_announcement_enabled: true },
]

describe('analysis chat announcement access', () => {
  it('marks direct streamer send available when user:write:chat is granted', () => {
    const rows = buildStreamerChatAccessRows({
      streamers,
      userScopes: [
        { twitch_user_id: '1001', twitch_scopes: ['user:read:email', 'user:write:chat'] },
      ],
      senderSettings: [],
      botAccounts: [],
    })

    expect(rows.find((row) => row.streamer_id === 'streamer-with-scope')).toMatchObject({
      has_chat_scope: true,
      has_active_bot_sender: false,
      chat_send_available: true,
      sender_mode: 'streamer',
    })
  })

  it('marks streamer send unavailable when neither scope nor bot sender is available', () => {
    const rows = buildStreamerChatAccessRows({
      streamers,
      userScopes: [
        { twitch_user_id: '1002', twitch_scopes: ['user:read:email'] },
      ],
      senderSettings: [],
      botAccounts: [],
    })

    expect(rows.find((row) => row.streamer_id === 'streamer-missing-scope')).toMatchObject({
      has_chat_scope: false,
      has_active_bot_sender: false,
      chat_send_available: false,
      sender_mode: 'streamer',
    })
  })

  it('treats an active custom bot as send-capable without broadcaster chat scope', () => {
    const rows = buildStreamerChatAccessRows({
      streamers,
      userScopes: [
        { twitch_user_id: '1003', twitch_scopes: [] },
      ],
      senderSettings: [
        {
          streamer_id: 'streamer-custom-bot',
          sender_mode: 'custom_bot',
          custom_bot_account_id: 'bot-1',
        },
      ],
      botAccounts: [
        {
          id: 'bot-1',
          owner_type: 'streamer',
          streamer_id: 'streamer-custom-bot',
          status: 'active',
        },
      ],
    })

    expect(rows.find((row) => row.streamer_id === 'streamer-custom-bot')).toMatchObject({
      has_chat_scope: false,
      has_active_bot_sender: true,
      chat_send_available: true,
      sender_mode: 'custom_bot',
    })
  })

  it('treats an active official bot as send-capable without broadcaster chat scope', () => {
    const rows = buildStreamerChatAccessRows({
      streamers,
      userScopes: [
        { twitch_user_id: '1004', twitch_scopes: null },
      ],
      senderSettings: [
        {
          streamer_id: 'streamer-official-bot',
          sender_mode: 'official_bot',
          custom_bot_account_id: null,
        },
      ],
      botAccounts: [
        {
          id: 'bot-system',
          owner_type: 'system',
          streamer_id: null,
          status: 'active',
        },
      ],
    })

    expect(rows.find((row) => row.streamer_id === 'streamer-official-bot')).toMatchObject({
      has_chat_scope: false,
      has_active_bot_sender: true,
      chat_send_available: true,
      sender_mode: 'official_bot',
    })
  })

  it('defaults missing sender settings to streamer mode', () => {
    const rows = buildStreamerChatAccessRows({
      streamers,
      userScopes: [],
      senderSettings: [],
      botAccounts: [],
    })

    expect(rows.find((row) => row.streamer_id === 'streamer-no-settings')).toMatchObject({
      has_chat_scope: false,
      has_active_bot_sender: false,
      chat_send_available: false,
      sender_mode: 'streamer',
    })
  })
})
