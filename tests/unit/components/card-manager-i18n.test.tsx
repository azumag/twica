import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CardManager from '@/components/CardManager'
import enMessages from '../../../messages/en.json'
import { baseCard } from '../../utils/card-manager-test-helpers'

vi.mock('@/lib/logger')

describe('CardManager i18n safety messages', () => {
  afterEach(() => {
    // このテストは confirm と fetch を差し替えるため、後続テストへブラウザAPIの
    // モックが漏れないように各テスト終了時に必ず元へ戻す。
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('英語の完全削除確認を表示し、キャンセル時は削除APIを呼ばない', () => {
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CardManager
          streamerId="streamer-1"
          initialCards={[baseCard({ id: 'card-1' })]}
          initialRarityWeights={{}}
        />
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }))

    expect(confirmMock).toHaveBeenCalledWith(
      'Permanently delete this card?\n\n⚠️ This will also remove the card from all users who own it.'
    )

    // `fetch(url, init)` と `fetch(new Request(url, init))` のどちらでも、対象カードへの
    // DELETEが発生していないことを判定する。呼び出し形式に依存した検証にすると、
    // キャンセル後の削除回帰を見逃すため、URLとmethodを正規化して確認する。
    const fetchCalls = fetchMock.mock.calls as unknown as Array<[
      RequestInfo | URL,
      RequestInit | undefined,
    ]>
    const targetDeleteCalls = fetchCalls.filter(([input, init]) => {
      const requestLike = typeof input === 'object' && input !== null && 'url' in input
        ? (input as Request)
        : null
      const url = requestLike?.url ?? String(input)
      const method = requestLike?.method ?? init?.method ?? 'GET'
      return url.endsWith('/api/cards/card-1') && method.toUpperCase() === 'DELETE'
    })
    expect(targetDeleteCalls).toHaveLength(0)
  })
})
