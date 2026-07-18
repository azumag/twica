import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import BatchDropRateManualContent from '@/components/BatchDropRateManualContent'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import type { Card } from '@/types/database'
import jaMessages from '../../../messages/ja.json'

vi.mock('@/lib/logger')

// #694 Stage 6b: 「ガチャ関連」カテゴリの代表として
// BatchDropRateManualContent（/api/cards/batch-update への書き込み、
// ドロップ率一括保存）を検証する。

const baseCard = (overrides: Partial<Card>): Card => ({
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カードA',
  description: '',
  image_url: null,
  rarity: 'common',
  card_number: null,
  max_issuance_count: null,
  collection_name: null,
  drop_rate: 0.25,
  intra_rarity_weight: 1,
  is_active: true,
  hp: 10,
  atk: 5,
  def: 5,
  spd: 5,
  skill_type: 'attack',
  skill_name: 'たいあたり',
  skill_power: 10,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  ...overrides,
})

function renderContent(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <BatchDropRateManualContent
          onClose={vi.fn()}
          cards={[baseCard({ id: 'a' })]}
          streamerId="streamer-1"
          onSave={vi.fn()}
          onSwitchToAutoMode={vi.fn()}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
}

// レアリティ別タブ（デフォルト表示）のスライダーを動かして hasChanges=true にする。
function makeChange() {
  const slider = document.querySelector('input[type="range"]') as HTMLInputElement
  fireEvent.change(slider, { target: { value: '0.5' } })
}

describe('BatchDropRateManualContent maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off で変更ありのときは保存ボタンが操作可能（既存挙動を壊さない）', () => {
    renderContent({ mode: 'off' })
    makeChange()

    const saveButton = screen.getByRole('button', { name: '一括保存' })
    expect(saveButton).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときは変更ありでも保存ボタンがdisableされ、案内文言が表示される（事前disable）', () => {
    renderContent({ mode: 'read-only' })
    makeChange()

    const saveButton = screen.getByRole('button', { name: '一括保存' })
    expect(saveButton).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('incident-read-only でも同様にdisableされる', () => {
    renderContent({ mode: 'incident-read-only' })
    makeChange()
    expect(screen.getByRole('button', { name: '一括保存' })).toBeDisabled()
  })

  it('変更なしのときはmode=offでも保存ボタンはdisabled（既存のhasChangesガード）', () => {
    renderContent({ mode: 'off' })
    expect(screen.getByRole('button', { name: '一括保存' })).toBeDisabled()
  })

  it('事前disableをすり抜けて書き込みが503(maintenance)で拒否された場合、サーバーの案内文言をalertで表示する', async () => {
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'maintenance_read_only',
            message: 'ただいまメンテナンス中です。しばらくしてから再度お試しください。',
            retryable: true,
          },
        }),
        { status: 503 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    // ポーリング間隔中に切り替わった想定: UI上はまだmode=offなので保存ボタンは押せる
    renderContent({ mode: 'off' })
    makeChange()
    fireEvent.click(screen.getByRole('button', { name: '一括保存' }))

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(
        'ただいまメンテナンス中です。しばらくしてから再度お試しください。'
      )
    })

    alertMock.mockRestore()
  })
})
