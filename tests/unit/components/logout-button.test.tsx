import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LogoutButton } from '@/components/LogoutButton'

describe('LogoutButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logout が 403 のとき /api/session で CSRF を再発行してから 1 回だけ再試行する', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const locationSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)

    render(
      <LogoutButton label="logout">
        <span>Logout</span>
      </LogoutButton>
    )

    fireEvent.click(screen.getByRole('button', { name: /logout/i }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        '/api/auth/logout',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      )
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        '/api/session',
        expect.objectContaining({ credentials: 'include', cache: 'no-store' })
      )
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        '/api/auth/logout',
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      )
      expect(locationSpy).toHaveBeenCalled()
    })

    locationSpy.mockRestore()
  })
})
