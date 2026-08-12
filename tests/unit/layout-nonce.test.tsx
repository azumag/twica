import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import RootLayout from '@/app/layout'

/**
 * #950: layout.tsx が middleware 発行の x-nonce を Cloudflare Insights Script へ
 * 渡すこと（CSP nonce 契約の単体テスト）。next/script をスタブして props を捕捉する。
 */
const mocks = vi.hoisted(() => ({
  scriptProps: [] as Record<string, unknown>[],
  headersMock: vi.fn(),
}))

vi.mock('next/script', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.scriptProps.push(props)
    return null
  },
}))

vi.mock('next/headers', () => ({
  headers: mocks.headersMock,
}))

vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ja',
  getMessages: async () => ({}),
}))

const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js'

describe('RootLayout nonce propagation (issue #950)', () => {
  beforeEach(() => {
    mocks.scriptProps.length = 0
    mocks.headersMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('TOKEN 設定時は Script へ x-nonce を渡す', async () => {
    vi.stubEnv('NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN', 'token123')
    mocks.headersMock.mockResolvedValue(new Headers({ 'x-nonce': 'nonce-abc' }))

    render(await RootLayout({ children: <div>children</div> }))

    const script = mocks.scriptProps.find((p) => p.src === BEACON_SRC)
    expect(script).toBeDefined()
    expect(script?.nonce).toBe('nonce-abc')
  })

  it('x-nonce が無い場合は Script の nonce が undefined', async () => {
    vi.stubEnv('NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN', 'token123')
    mocks.headersMock.mockResolvedValue(new Headers())

    render(await RootLayout({ children: <div>children</div> }))

    const script = mocks.scriptProps.find((p) => p.src === BEACON_SRC)
    expect(script?.nonce).toBeUndefined()
  })

  it('TOKEN 未設定時は Script を描画しない', async () => {
    vi.stubEnv('NEXT_PUBLIC_CF_WEB_ANALYTICS_TOKEN', '')
    mocks.headersMock.mockResolvedValue(new Headers({ 'x-nonce': 'nonce-abc' }))

    render(await RootLayout({ children: <div>children</div> }))

    expect(mocks.scriptProps.length).toBe(0)
  })
})
