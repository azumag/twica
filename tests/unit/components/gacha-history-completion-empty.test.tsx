import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import GachaHistoryTable from '@/components/GachaHistoryTable'
import jaMessages from '../../../messages/ja.json'

describe('GachaHistoryTable completion history empty state (#873)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the existing user gacha history visible when completions is empty', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        users: [{
          userTwitchId: '123456789',
          username: 'alice',
          drawCount: 1,
          uniqueCards: 1,
          uniqueCardIds: ['card-1'],
          lastDrawAt: '2026-03-03T00:00:00Z',
        }],
        pagination: { page: 1, perPage: 20, total: 1, totalPages: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        history: [{
          id: 'history-1',
          redeemed_at: '2026-03-03T00:00:00Z',
          user_twitch_id: '123456789',
          user_twitch_username: 'alice',
          card_id: 'card-1',
          streamer_id: 'streamer-id-1',
          cards: {
            id: 'card-1',
            name: 'カード1',
            image_url: null,
            image_padding_color: null,
            rarity: 'common',
          },
        }],
        pagination: { page: 1, perPage: 20, total: 1, totalPages: 1 },
        completions: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <GachaHistoryTable
          initialHistory={[]}
          initialPagination={{ page: 1, perPage: 20, total: 0, totalPages: 0 }}
          isStreamer
          cards={[{ id: 'card-1', name: 'カード1' }]}
          totalActiveCards={1}
        />
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: jaMessages.gachaHistoryPage.tabs.users }))
    await screen.findByRole('button', { name: /alice/ })
    fireEvent.click(screen.getByRole('button', { name: /alice/ }))

    expect(await screen.findByText('カード1')).toBeTruthy()
    expect(screen.queryByText(jaMessages.collectionProgress.complete)).toBeNull()
  })
})
