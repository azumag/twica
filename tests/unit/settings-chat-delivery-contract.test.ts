import { describe, expect, it } from 'vitest'
import { resolveChatAnnouncementSectionStatus } from '@/lib/chat-delivery-ui'

describe('settings chat delivery capability contract', () => {
  it.each([
    [{ enabled: true, needsAttention: true }, 'attention'],
    [{ enabled: true, needsAttention: false }, 'active'],
    [{ enabled: false, needsAttention: false }, 'empty'],
    // server helperが確定した不足判定を最優先する。normally impossibleな組み合わせも
    // attentionへ倒すことで、clientが別材料から警告を打ち消す回帰を防ぐ。
    [{ enabled: false, needsAttention: true }, 'attention'],
  ] as const)('server確定値をclientで再計算せずsection状態へ写す: %o', (input, expected) => {
    expect(resolveChatAnnouncementSectionStatus(input)).toBe(expected)
  })
})
