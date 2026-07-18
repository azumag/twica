import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import BattlePage from '@/app/battle/page'
import { MaintenanceStatusContext } from '@/components/MaintenanceStatusProvider'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'
import type { Session } from '@/lib/session'
import type { UserCardWithDetails } from '@/types/database'
import jaMessages from '../../messages/ja.json'

// BattlePageのloadData useEffectは依存配列に[router]を持つため、useRouter()が
// 呼び出しごとに新しいオブジェクト参照を返すと再レンダーのたびにeffectが
// 再発火し続けてしまう（無限re-fetchループ、actの警告の原因にもなる）。
// モジュールスコープの安定した参照を返すことでこれを防ぐ。
const routerMock = { push: vi.fn(), refresh: vi.fn() }
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}))

const fetchSessionMock = vi.fn()
vi.mock('@/lib/api-client', () => ({
  fetchSession: () => fetchSessionMock(),
}))

// #694 Stage 6c: 「カード対戦」カテゴリの代表として /battle (BattlePage) の
// POST /api/battle/start (CPU対戦開始) を検証する。
//
// #785で battle/layout.tsx に MaintenanceStatusProvider を設置したため、
// 以下の MaintenanceStatusContext.Provider 直接注入は本番の実配線と同じ経路
// （Context経由でのmaintenance状態取得）を模したものになっている
// （事前disableをすり抜けた場合の最終防御は、parseMaintenanceErrorによる
// fetch失敗時のサーバー案内文言表示で担保される）。

const fakeSession = { twitchUserId: 'user-1' } as unknown as Session

const fakeUserCard: UserCardWithDetails = {
  id: 'user-card-1',
  user_id: 'user-1',
  card_id: 'card-1',
  obtained_at: '2026-07-01T00:00:00Z',
  card: {
    id: 'card-1',
    streamer_id: 'streamer-1',
    name: 'テストカード',
    description: null,
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
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  },
} as unknown as UserCardWithDetails

function mockFetch(userCardsResponse: unknown, battleStartHandler?: () => Response) {
  return vi.fn((url: string) => {
    if (String(url).includes('/api/user-cards')) {
      return Promise.resolve(
        new Response(JSON.stringify(userCardsResponse), { status: 200 })
      )
    }
    if (String(url).includes('/api/battle/start')) {
      return Promise.resolve(
        battleStartHandler ? battleStartHandler() : new Response(JSON.stringify({}), { status: 200 })
      )
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
}

async function renderBattlePage(status: MaintenanceStatusResponse) {
  fetchSessionMock.mockResolvedValue(fakeSession)
  const result = render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <BattlePage />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  )
  // カード選択カードが描画されるまで待つ（読み込み完了の同期ポイント）
  await screen.findByText('テストカード')
  fireEvent.click(screen.getByText('テストカード'))
  return result
}

describe('BattlePage maintenance integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchSessionMock.mockReset()
  })

  it('mode=off のときはCPU対戦開始ボタンが操作可能（既存挙動を壊さない）', async () => {
    vi.stubGlobal('fetch', mockFetch([fakeUserCard]))

    await renderBattlePage({ mode: 'off' })

    expect(screen.getByRole('button', { name: 'CPU対戦を開始' })).not.toBeDisabled()
    expect(screen.queryByText('メンテナンス中は操作できません')).not.toBeInTheDocument()
  })

  it('mode!=off のときはCPU対戦開始ボタンがdisableされ、案内文言が表示される（事前disable、Provider経由）', async () => {
    vi.stubGlobal('fetch', mockFetch([fakeUserCard]))

    await renderBattlePage({ mode: 'read-only' })

    expect(screen.getByRole('button', { name: 'CPU対戦を開始' })).toBeDisabled()
    expect(screen.getByText('メンテナンス中は操作できません')).toBeInTheDocument()
  })

  it('事前disableをすり抜けて対戦開始がmaintenance 503で拒否された場合、alertでサーバーの案内文言を表示する', async () => {
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const maintenanceResponse = () =>
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
    vi.stubGlobal('fetch', mockFetch([fakeUserCard], maintenanceResponse))

    await renderBattlePage({ mode: 'off' })
    fireEvent.click(screen.getByRole('button', { name: 'CPU対戦を開始' }))

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(
        'ただいまメンテナンス中です。しばらくしてから再度お試しください。'
      )
    })
    alertMock.mockRestore()
  })
})
