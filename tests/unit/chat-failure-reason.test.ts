import { describe, expect, it } from 'vitest'
import { formatChatFailureReason } from '@/lib/twitch/chat-failure-reason'
import type { ChatSendDegradation } from '@/lib/twitch/chat-service'

describe('formatChatFailureReason', () => {
  it('returns the original reason when no degradation is present', () => {
    expect(formatChatFailureReason('Twitch API unavailable')).toBe('Twitch API unavailable')
  })

  it('appends the sender degradation reason exactly once', () => {
    const degradation: ChatSendDegradation = {
      code: 'credential_unavailable',
      reason: 'configured bot credential requires re-authentication',
    }

    expect(formatChatFailureReason('Chat delivery failed', degradation)).toBe(
      'Chat delivery failed; sender degraded: configured bot credential requires re-authentication',
    )
  })
})
