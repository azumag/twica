import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { renderToString } from 'react-dom/server'
import { hydrateRoot } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import CollectionProgress from '@/components/CollectionProgress'
import jaMessages from '../../../messages/ja.json'

// Issue #557 の回帰: CollectionProgress が Server→Client Component 化された結果、
// 達成日時表示が hydration の対象になった。formatDateTime は Intl.DateTimeFormat に
// timeZone を指定していないため、SSR (Cloudflare Workers = UTC 想定) とクライアント
// (ユーザーのローカルTZ、例: JST) で整形結果が異なり、React error #418
// (hydration text mismatch) がコンソールに出ていた。
//
// 修正は timeZone を固定するのではなく（全ユーザーにJSTを強制してしまうため）、
// 達成日時を含む要素に suppressHydrationWarning を付与して警告を抑制する方針。
// ここでは実際に renderToString → hydrateRoot を行い、サーバー/クライアントで
// フォーマット結果が異なる状況でも console.error が呼ばれないことを確認する。
describe('CollectionProgress hydration mismatch (Issue #557 regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  const baseProps = {
    owned: 3,
    total: 3,
    completionHistory: [
      { total_cards: 3, completed_at: '2026-01-01T00:00:00Z' },
      { total_cards: 2, completed_at: '2025-06-01T00:00:00Z' },
    ],
  }

  it('does not log a hydration warning even when the formatted date differs between server and client render', async () => {
    // Intl.DateTimeFormat をモックし、1回目の呼び出し（SSR相当）と2回目以降の呼び出し
    // （クライアント相当）で異なる文字列を返すことで、UTC/JSTのようなTZ差を再現する。
    let callCount = 0
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      callCount += 1
      const isServerRender = callCount <= baseProps.completionHistory.length
      return {
        format: () =>
          isServerRender ? '2026/01/01 00:00:00 (server)' : '2026/01/01 09:00:00 (client)',
      } as unknown as Intl.DateTimeFormat
    })

    const tree = (
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <CollectionProgress {...baseProps} />
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

  it('renders suppressHydrationWarning on the timestamp elements (source-level guard against regressions)', async () => {
    // suppressHydrationWarning は DOM 属性として出力されないため描画結果からは検証できない。
    // 上のhydrateRootテストが実挙動の検証を担う一方、ここでは実装がsuppressHydrationWarningの
    // 付与という修正方針から外れて削除されていないかをソースレベルで軽く検知する。
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const source = await fs.readFile(
      path.resolve(__dirname, '../../../src/components/CollectionProgress.tsx'),
      'utf-8'
    )
    const occurrences = source.match(/suppressHydrationWarning/g) ?? []
    // 現在コンプリート中の達成日時 + 過去履歴の各行、の2箇所
    expect(occurrences.length).toBeGreaterThanOrEqual(2)
  })
})
