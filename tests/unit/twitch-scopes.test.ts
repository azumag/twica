import { describe, it, expect } from 'vitest'

// 重要: このテストは意図的に vi.mock('@/lib/env-validation') を行わない。
// `@/lib/twitch/scopes` がクライアント安全 (サーバー専用依存を import しない)
// であることを契約としてロックするため、env-validation をモックせずに評価する。
// もし誰かが scopes.ts に env-validation (や他のサーバー専用モジュール) を
// import してしまうと、テスト環境で副作用が走り失敗して回帰を検知できる。
//
// IMPORTANT: this test intentionally does NOT mock '@/lib/env-validation'.
// It locks the contract that '@/lib/twitch/scopes' has no server-only
// transitive imports, so that the module can be safely bundled into
// "use client" components (see PR #405 review P1).
describe('@/lib/twitch/scopes (client-safe scope constants)', () => {
  it('server-only 依存なしで評価できる (env-validation を mock せずに import)', async () => {
    const mod = await import('@/lib/twitch/scopes')
    expect(mod.AUTH_SCOPES).toBe('user:read:email')
    expect(mod.ADDITIONAL_SCOPES).toMatchObject({
      CHAT_WRITE: 'user:write:chat',
      USER_READ_SUBSCRIPTIONS: 'user:read:subscriptions',
      CHANNEL_READ_REDEMPTIONS: 'channel:read:redemptions',
      CHANNEL_MANAGE_REDEMPTIONS: 'channel:manage:redemptions',
    })
    expect(mod.CHANNEL_POINT_SCOPES).toEqual([
      'channel:read:redemptions',
      'channel:manage:redemptions',
    ])
  })
})
