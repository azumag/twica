import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, type ComponentProps } from 'react'
import { renderToString } from 'react-dom/server'
import { hydrateRoot } from 'react-dom/client'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import GachaHistoryTable from '@/components/GachaHistoryTable'
import jaMessages from '../../../messages/ja.json'

// Issue #776 の回帰: GachaHistoryTable の「自分の履歴」「ユーザー履歴」タブ表示時に
// React error #418 (hydration text mismatch) がコンソールに出ていた。
// `new Date(...).toLocaleString(locale)` / `toLocaleDateString(locale)` は
// timeZone を指定していないため、SSR (Cloudflare Workers = UTC 想定) と
// クライアント (ユーザーのローカルTZ、例: JST) で整形結果が異なる。
//
// 修正方針は CollectionProgress.tsx (Issue #557/#563) と同じく、timeZone を
// 固定するのではなく（全ユーザーにその TZ を強制してしまうため）、日時を含む
// 要素に suppressHydrationWarning を付与し、「ユーザーのローカルタイムゾーンで
// 表示する」意図した挙動を保ったまま警告を抑制する。
//
// ここでは実際に renderToString → hydrateRoot を行い、サーバー/クライアントで
// toLocaleString の結果が異なる状況でも console.error が呼ばれないことを検証する。
describe('GachaHistoryTable hydration mismatch (Issue #776 regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  type Props = ComponentProps<typeof GachaHistoryTable>

  // 視聴者（非配信者）のデフォルト表示（"自分の履歴"相当）を再現する最小限のprops。
  // isStreamer: false の場合タブは表示されないが、履歴一覧（redeemed_atを含む）は
  // 通常どおり描画されるため、Issue #776 が報告した hydration mismatch の再現に十分。
  const baseProps: Props = {
    initialHistory: [
      {
        id: 'history-1',
        redeemed_at: '2026-01-01T00:00:00Z',
        user_twitch_username: 'viewer1',
        cards: { id: 'card-1', name: 'テストカード', image_url: null,
  image_padding_color: null, rarity: 'common' },
      },
    ] as unknown as Props['initialHistory'],
    initialPagination: { page: 1, perPage: 20, total: 1, totalPages: 1 },
    isStreamer: false,
  }

  it('does not log a hydration warning even when toLocaleString differs between server and client render', async () => {
    // Date.prototype.toLocaleString をモックし、1回目の呼び出し（SSR相当）と
    // 2回目以降の呼び出し（クライアント相当）で異なる文字列を返すことで、
    // UTC/JSTのようなタイムゾーン差を再現する。
    let callCount = 0
    vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(() => {
      callCount += 1
      return callCount === 1 ? '2026/1/1 0:00:00 (server)' : '2026/1/1 9:00:00 (client)'
    })

    const tree = (
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <GachaHistoryTable {...baseProps} />
      </NextIntlClientProvider>
    )

    const html = renderToString(tree)
    const container = document.createElement('div')
    container.innerHTML = html
    document.body.appendChild(container)

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // React はハイドレーション時のミスマッチ警告をスケジューラのタスクとして
    // 非同期に出力するため、act(async () => {...}) でハイドレーション作業と
    // それに伴う警告出力の完了まで待ってから console.error の呼び出しを検証する。
    await act(async () => {
      hydrateRoot(container, tree)
    })

    // React はハイドレーションミスマッチを console.error(Error) の形で報告する
    // （第一引数が文字列とは限らず Error インスタンスのこともある）ため、
    // message も含めて文字列化してから判定する。
    const hydrationMismatchLogged = consoleErrorSpy.mock.calls.some((args) =>
      args.some((arg) => {
        const text = arg instanceof Error ? arg.message : String(arg)
        return text.includes("didn't match") || text.includes('Hydration failed')
      })
    )
    expect(hydrationMismatchLogged).toBe(false)
  })

  it('renders suppressHydrationWarning on all three timestamp elements (source-level guard against regressions)', async () => {
    // suppressHydrationWarning は DOM 属性として出力されないため描画結果からは検証できない。
    // 上の hydrateRoot テストが実挙動の検証を担う一方、ここでは実装が
    // suppressHydrationWarning の付与という修正方針から外れて削除されていないかを
    // ソースレベルで軽く検知する。
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const source = await fs.readFile(
      path.resolve(__dirname, '../../../src/components/GachaHistoryTable.tsx'),
      'utf-8'
    )
    // コメント中の同語を数えないよう、JSX属性としての出現
    // (`suppressHydrationWarning>` = 属性が要素タグ末尾に付く形) のみをカウントする。
    // 属性を消してコメントだけ残す回帰でもこのテストが赤になるようにするため
    // (Fableレビュー指摘)。
    const occurrences = source.match(/suppressHydrationWarning>/g) ?? []
    // users一覧の最終ドロー日 (toLocaleDateString) + 履歴一覧のredeemed_at
    // (toLocaleString) + ユーザー詳細パネル内redeemed_at (toLocaleString) の3箇所以上。
    // #873 のコンプリート日時にも同じローカルTZ方針を適用している。
    expect(occurrences.length).toBeGreaterThanOrEqual(4)
  })

  it('renders overall and pack completion history in the streamer user detail panel', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        users: [{
          userTwitchId: '123456789',
          username: 'alice',
          drawCount: 2,
          uniqueCards: 1,
          uniqueCardIds: ['card-1'],
          lastDrawAt: '2026-03-03T00:00:00Z',
        }],
        pagination: { page: 1, perPage: 20, total: 1, totalPages: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        history: [],
        pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
        completions: [
          { total_cards: 8, completed_at: '2026-03-01T00:00:00Z', collection_name: null },
          { total_cards: 3, completed_at: '2026-03-02T00:00:00Z', collection_name: '第一弾' },
          { total_cards: 2, completed_at: '2026-03-03T00:00:00Z', collection_name: '__default__' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <GachaHistoryTable
          initialHistory={[]}
          initialPagination={{ page: 1, perPage: 20, total: 0, totalPages: 0 }}
          isStreamer
          cards={[{ id: 'card-1', name: 'カード1' }]}
          totalActiveCards={8}
        />
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: jaMessages.gachaHistoryPage.tabs.users }))
    await screen.findByRole('button', { name: /alice/ })
    fireEvent.click(screen.getByRole('button', { name: /alice/ }))

    await screen.findByText('第一弾')
    expect(screen.getByText(jaMessages.channelPointSettings.collections.defaultOnlyName)).toBeTruthy()
    expect(screen.getByText(/全8種時にコンプリート達成/)).toBeTruthy()
    expect(screen.getByText(/全3種時にコンプリート達成/)).toBeTruthy()
    expect(screen.getByText(/全2種時にコンプリート達成/)).toBeTruthy()
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    expect(fetchSpy.mock.calls[1]?.[0]).toContain('userId=123456789')
  })

  it('keeps loading owned by the latest user detail request after the previous request aborts', async () => {
    let resolveSecondDetail: ((response: Response) => void) | undefined
    let resolveFirstAbort: (() => void) | undefined
    const firstAbort = new Promise<void>((resolve) => {
      resolveFirstAbort = resolve
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input)
      if (url.includes('view=users')) {
        return Promise.resolve(new Response(JSON.stringify({
          users: [
            {
              userTwitchId: 'user-a',
              username: 'alice',
              drawCount: 1,
              uniqueCards: 1,
              uniqueCardIds: ['card-a'],
              lastDrawAt: '2026-03-01T00:00:00Z',
            },
            {
              userTwitchId: 'user-b',
              username: 'bob',
              drawCount: 1,
              uniqueCards: 1,
              uniqueCardIds: ['card-b'],
              lastDrawAt: '2026-03-02T00:00:00Z',
            },
          ],
          pagination: { page: 1, perPage: 20, total: 2, totalPages: 1 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }

      if (url.includes('userId=user-a')) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) {
            reject(new Error('user detail request must carry an abort signal'))
            return
          }
          signal.addEventListener('abort', () => {
            resolveFirstAbort?.()
            reject(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
        })
      }

      if (url.includes('userId=user-b')) {
        return new Promise<Response>((resolve) => {
          resolveSecondDetail = resolve
        })
      }

      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <GachaHistoryTable
          initialHistory={[]}
          initialPagination={{ page: 1, perPage: 20, total: 0, totalPages: 0 }}
          isStreamer
          cards={[
            { id: 'card-a', name: 'Aliceカード' },
            { id: 'card-b', name: 'Bobカード' },
          ]}
          totalActiveCards={2}
        />
      </NextIntlClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: jaMessages.gachaHistoryPage.tabs.users }))
    await screen.findByRole('button', { name: /alice/ })
    await screen.findByRole('button', { name: /bob/ })

    fireEvent.click(screen.getByRole('button', { name: /alice/ }))
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: /bob/ }))

    // Wait until request A has actually rejected due to B aborting it and React
    // has flushed A's catch/finally. The stale finally must not clear B's spinner.
    await act(async () => {
      await firstAbort
      await Promise.resolve()
    })
    expect(document.querySelector('.fixed .opacity-50')).not.toBeNull()

    await act(async () => {
      resolveSecondDetail?.(new Response(JSON.stringify({
        history: [{
          id: 'history-b',
          redeemed_at: '2026-03-02T00:00:00Z',
          cards: {
            id: 'card-b',
            name: 'Bobカード',
            image_url: null,
            image_padding_color: null,
            rarity: 'common',
          },
        }],
        pagination: { page: 1, perPage: 20, total: 1, totalPages: 1 },
        completions: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      await Promise.resolve()
    })

    await screen.findByText('Bobカード')
    await waitFor(() => expect(document.querySelector('.fixed .opacity-50')).toBeNull())
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })
})
