import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OverlayAura } from '@/components/OverlayAura'

function stubBrowser({ reducedMotion }: { reducedMotion: boolean }) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(448)

  const createImageData = vi.fn((width: number, height: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  }))
  const putImageData = vi.fn<CanvasRenderingContext2D['putImageData']>()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createImageData,
    putImageData,
  } as unknown as CanvasRenderingContext2D)

  const disconnect = vi.fn()
  let resize: (() => void) | undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) {
      resize = callback
    }
    observe() {}
    disconnect = disconnect
  })

  const motion = {
    matches: reducedMotion,
    addEventListener: vi.fn<(type: 'change', listener: () => void) => void>(),
    removeEventListener: vi.fn(),
  }
  vi.spyOn(window, 'matchMedia').mockReturnValue(motion as unknown as MediaQueryList)

  let frameId = 0
  const requestFrame = vi.fn<typeof requestAnimationFrame>(() => ++frameId)
  const cancelFrame = vi.fn<typeof cancelAnimationFrame>()
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)

  return {
    resize: () => act(() => resize?.()),
    draw: (at: number) => act(() => requestFrame.mock.lastCall?.[0](at)),
    disconnect,
    putImageData,
    requestFrame,
    cancelFrame,
    motion,
  }
}

const aura = <OverlayAura colorFrom="#fdc700" colorTo="#ff6900" cornerRadius={16} />

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('OverlayAura', () => {
  it('draws visible flame pixels in reduced motion without requesting animation', () => {
    const browser = stubBrowser({ reducedMotion: true })
    render(aura)

    browser.resize()

    const image = browser.putImageData.mock.lastCall?.[0]
    expect(image?.data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true)
    expect(browser.requestFrame).not.toHaveBeenCalled()
  })

  it('cancels the next frame and releases browser listeners on unmount', () => {
    const browser = stubBrowser({ reducedMotion: false })
    const { unmount } = render(aura)

    browser.resize()
    browser.draw(performance.now() + 40)

    const pendingFrame = browser.requestFrame.mock.results.at(-1)?.value
    expect(pendingFrame).toBe(2)
    expect(browser.putImageData).toHaveBeenCalledTimes(1)

    unmount()

    expect(browser.cancelFrame).toHaveBeenLastCalledWith(pendingFrame)
    expect(browser.disconnect).toHaveBeenCalledTimes(1)
    expect(browser.motion.removeEventListener).toHaveBeenCalledWith(
      ...browser.motion.addEventListener.mock.calls[0],
    )
  })
})
