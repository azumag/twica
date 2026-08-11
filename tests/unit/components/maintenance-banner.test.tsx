import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import MaintenanceBanner from '@/components/MaintenanceBanner'
import {
  MaintenanceStatusContext,
  type MaintenanceStatusContextValue,
} from '@/components/MaintenanceStatusProvider'
import jaMessages from '../../../messages/ja.json'
import enMessages from '../../../messages/en.json'

// MaintenanceStatusProvider の非同期fetch/pollingを経由せず、Contextへ直接
// statusを注入してバナーの表示ロジックだけを検証する（テスト用にexportされた
// 生Context。MaintenanceStatusProvider.tsx参照）。
function renderBanner(
  status: MaintenanceStatusContextValue,
  { locale = 'ja', messages = jaMessages }: { locale?: string; messages?: typeof jaMessages } = {}
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <MaintenanceStatusContext.Provider value={status}>
        <MaintenanceBanner />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

describe('MaintenanceBanner', () => {
  it('mode=off のときは可視バナーを描画しない', () => {
    renderBanner({ mode: 'off' })
    // 可視バナー本文は出ない
    expect(screen.queryByText(/メンテナンス/)).not.toBeInTheDocument()
  })

  it('mode=off でもMaintenanceAnnouncer（sr-only）は常にマウントされている', () => {
    renderBanner({ mode: 'off' })
    // MaintenanceAnnouncerはrole="status"のsr-onlyリージョンを常時マウントする
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('mode=read-only のときはmodes.readOnlyのデフォルト文言を表示する', () => {
    renderBanner({ mode: 'read-only' })
    expect(
      screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
    ).toBeInTheDocument()
  })

  it('visible復帰の再確認中はwriteを止めても一時的なwarnを表示・通知しない', () => {
    renderBanner({ mode: 'read-only', isRefreshing: true })

    expect(screen.queryByText(/メンテナンス/)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('mode=cutover-validating のときはmodes.cutoverValidatingの文言を表示する', () => {
    renderBanner({ mode: 'cutover-validating' })
    expect(
      screen.getByText('ただいまシステム移行の検証中です。しばらくしてから再度お試しください。')
    ).toBeInTheDocument()
  })

  it('mode=incident-read-only のときはmodes.incidentReadOnlyの文言を表示する', () => {
    renderBanner({ mode: 'incident-read-only' })
    expect(
      screen.getByText('ただいま障害対応のため書き込みを制限しています。しばらくしてから再度お試しください。')
    ).toBeInTheDocument()
  })

  it('publicMessageKeyが辞書に存在する場合はそちらを優先する', () => {
    renderBanner({ mode: 'read-only', publicMessageKey: 'planned' })
    expect(screen.getByText('計画メンテナンスを実施中です。')).toBeInTheDocument()
    expect(
      screen.queryByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
    ).not.toBeInTheDocument()
  })

  it('publicMessageKeyが辞書に存在しない場合はmode別デフォルトへフォールバックする', () => {
    renderBanner({ mode: 'read-only', publicMessageKey: 'unknown-key-not-in-dictionary' })
    expect(
      screen.getByText('ただいまメンテナンス中です。しばらくしてから再度お試しください。')
    ).toBeInTheDocument()
  })

  it('expectedEndAtがある場合は再開予定時刻を表示する', () => {
    renderBanner({ mode: 'read-only', expectedEndAt: '2026-07-20T12:34:00.000Z' })
    // ロケール依存の時刻フォーマットなので、resumeAtメッセージの枠組み（"頃再開予定"）
    // が出ることだけを確認する（正確な時刻文字列はIntl実装依存のため厳密一致しない）
    expect(screen.getByText(/頃再開予定/)).toBeInTheDocument()
  })

  it('expectedEndAtが無い場合は再開予定時刻を表示しない', () => {
    renderBanner({ mode: 'read-only' })
    expect(screen.queryByText(/頃再開予定/)).not.toBeInTheDocument()
  })

  it('expectedEndAtが不正な文字列なら再開予定時刻を表示しない（例外にしない）', () => {
    renderBanner({ mode: 'read-only', expectedEndAt: 'not-a-date' })
    expect(screen.queryByText(/頃再開予定/)).not.toBeInTheDocument()
  })

  it('enロケールでは英語の文言を表示する', () => {
    renderBanner({ mode: 'read-only' }, { locale: 'en', messages: enMessages })
    expect(
      screen.getByText('The service is currently under maintenance. Please try again later.')
    ).toBeInTheDocument()
  })
})
