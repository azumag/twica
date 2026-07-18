import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import MaintenanceAnnouncer from '@/components/MaintenanceAnnouncer'
import jaMessages from '../../../messages/ja.json'
import enMessages from '../../../messages/en.json'

// 既存コンポーネントテスト（collection-pack-filter.test.tsx 等）と同じパターン:
// next-intl の useTranslations は Provider 経由でしか動かないため、
// テストでも NextIntlClientProvider で実メッセージ（messages/ja.json）をラップする。
function renderAnnouncer(
  props: Parameters<typeof MaintenanceAnnouncer>[0],
  messages: typeof jaMessages = jaMessages
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={messages}>
      <MaintenanceAnnouncer {...props} />
    </NextIntlClientProvider>
  )
}

describe('MaintenanceAnnouncer', () => {
  it('常に role="status" + aria-live="polite" のライブリージョンをマウントする（mode=off でも）', () => {
    renderAnnouncer({ mode: 'off' })
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
  })

  it('mode=off のときは中身が空文字（何も読み上げない）', () => {
    renderAnnouncer({ mode: 'off', message: '本来出ないはずのメッセージ' })
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('')
  })

  it('mode!=off かつ message ありのとき、ラベル付きで読み上げ文言を表示する', () => {
    renderAnnouncer({ mode: 'read-only', message: 'ただいまメンテナンス中です。' })
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('メンテナンス状況: ただいまメンテナンス中です。')
  })

  it('mode!=off でも message が未指定なら空文字のまま（呼び出し元がメッセージ解決の責務を持つ）', () => {
    renderAnnouncer({ mode: 'incident-read-only' })
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('')
  })

  it('cutover-validating / incident-read-only でも同様に読み上げる', () => {
    renderAnnouncer({ mode: 'cutover-validating', message: '移行検証中です。' })
    expect(screen.getByRole('status')).toHaveTextContent('メンテナンス状況: 移行検証中です。')
  })

  it('視覚的には非表示（sr-only）', () => {
    renderAnnouncer({ mode: 'read-only', message: 'x' })
    expect(screen.getByRole('status')).toHaveClass('sr-only')
  })

  it('en ロケールでは英語のラベルで読み上げる', () => {
    renderAnnouncer(
      { mode: 'read-only', message: 'Maintenance is in progress.' },
      enMessages
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Maintenance status: Maintenance is in progress.'
    )
  })
})
