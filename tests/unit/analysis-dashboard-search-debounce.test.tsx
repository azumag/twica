import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleDebouncedValue } from '../../analysis/src/hooks/useDebouncedValue'

describe('analysis dashboard search debounce', () => {
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('連続入力中は検索語を更新せず、最後の値だけを反映する', () => {
    vi.useFakeTimers()
    const receivedValues: string[] = []
    let cleanup = () => {}

    const schedule = (value: string) => {
      cleanup()
      cleanup = scheduleDebouncedValue(value, 300, (nextValue) => {
        receivedValues.push(nextValue)
      })
    }

    schedule('')
    schedule('a')
    schedule('ab')
    expect(receivedValues).toEqual([])

    vi.advanceTimersByTime(299)
    expect(receivedValues).toEqual([])

    vi.advanceTimersByTime(1)
    expect(receivedValues).toEqual(['ab'])
    cleanup()
  })

  it('cleanup後は保留中の検索語を反映しない', () => {
    vi.useFakeTimers()
    const onValue = vi.fn()
    const cleanup = scheduleDebouncedValue('stale', 300, onValue)

    cleanup()
    vi.advanceTimersByTime(300)

    expect(onValue).not.toHaveBeenCalled()
  })
})
