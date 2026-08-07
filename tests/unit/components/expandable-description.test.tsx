import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { AnchorHTMLAttributes } from 'react'
import Link from 'next/link'
import ExpandableDescription from '@/components/ExpandableDescription'

type MockLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  prefetch?: boolean
}

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: MockLinkProps) => (
    <a {...props} data-prefetch={String(prefetch)} />
  ),
}))

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

type LayoutValue = number | (() => number)

let savedScrollHeightDescriptor: PropertyDescriptor | undefined
let savedClientHeightDescriptor: PropertyDescriptor | undefined

function stubLayout(scrollHeight: LayoutValue, clientHeight: LayoutValue) {
  const proto = HTMLElement.prototype
  const readLayoutValue = (value: LayoutValue) => typeof value === 'function' ? value() : value
  savedScrollHeightDescriptor = Object.getOwnPropertyDescriptor(proto, 'scrollHeight')
  savedClientHeightDescriptor = Object.getOwnPropertyDescriptor(proto, 'clientHeight')
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get: () => readLayoutValue(scrollHeight),
  })
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get: () => readLayoutValue(clientHeight),
  })
}

function installResizeObserver() {
  let callback: ResizeObserverCallback | undefined
  const disconnect = vi.fn()
  class TestResizeObserver {
    constructor(nextCallback: ResizeObserverCallback) {
      callback = nextCallback
    }

    observe() {}

    disconnect() {
      disconnect()
    }
  }

  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  return {
    notify() {
      act(() => {
        callback?.([], {} as ResizeObserver)
      })
    },
    disconnect,
  }
}

afterEach(() => {
  const proto = HTMLElement.prototype
  if (savedScrollHeightDescriptor) {
    Object.defineProperty(proto, 'scrollHeight', savedScrollHeightDescriptor)
  } else {
    delete (proto as unknown as Record<string, unknown>).scrollHeight
  }
  if (savedClientHeightDescriptor) {
    Object.defineProperty(proto, 'clientHeight', savedClientHeightDescriptor)
  } else {
    delete (proto as unknown as Record<string, unknown>).clientHeight
  }
  savedScrollHeightDescriptor = undefined
  savedClientHeightDescriptor = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ExpandableDescription', () => {
  it('keeps the detail link and disclosure button as separate interactive siblings', () => {
    stubLayout(100, 50)
    const parentClick = vi.fn()

    render(
      <div onClick={parentClick}>
        <ExpandableDescription
          description="長い説明テキスト"
          detailHref="/collection/streamer-1/card/card-1"
        />
      </div>
    )

    const detailLink = screen.getByRole('link')
    const button = screen.getByRole('button', { name: /expand/ })
    expect(detailLink.contains(button)).toBe(false)
    expect(detailLink).toHaveAttribute('data-prefetch', 'false')
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('aria-expanded', 'false')

    const description = screen.getByText('長い説明テキスト')
    const descriptionClick = createEvent.click(description)
    fireEvent(description, descriptionClick)
    expect(descriptionClick.defaultPrevented).toBe(false)
    parentClick.mockClear()

    button.focus()
    fireEvent.click(button)
    expect(parentClick).not.toHaveBeenCalled()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(button)

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(button)
  })

  it('prevents detail navigation from truncated text and disclosure controls', () => {
    stubLayout(100, 50)
    const parentClick = vi.fn()

    render(
      <Link href="/collection/streamer-1/card/card-1" onClick={parentClick}>
        <ExpandableDescription description="長い説明テキスト" />
      </Link>
    )

    const description = screen.getByText('長い説明テキスト')
    const textClick = createEvent.click(description)
    fireEvent(description, textClick)
    expect(textClick.defaultPrevented).toBe(true)
    expect(parentClick).not.toHaveBeenCalled()

    const button = screen.getByRole('button', { name: /expand/ })
    fireEvent.click(button)
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('preserves normal detail navigation for short description text', () => {
    stubLayout(50, 50)
    const parentClick = vi.fn()

    render(
      <Link href="/collection/streamer-1/card/card-1" onClick={parentClick}>
        <ExpandableDescription description="短い説明テキスト" />
      </Link>
    )

    const description = screen.getByText('短い説明テキスト')
    const click = createEvent.click(description)
    fireEvent(description, click)
    expect(click.defaultPrevented).toBe(false)
    expect(parentClick).toHaveBeenCalledTimes(1)
  })

  it('uses detailHref to navigate short text without nesting a button in the anchor', () => {
    stubLayout(50, 50)
    const parentClick = vi.fn()

    render(
      <div onClick={parentClick}>
        <ExpandableDescription
          description="短い説明テキスト"
          detailHref="/collection/streamer-1/card/card-1"
        />
      </div>
    )

    const detailLink = screen.getByRole('link')
    const description = screen.getByText('短い説明テキスト')
    const click = createEvent.click(description)
    fireEvent(description, click)
    expect(detailLink.contains(screen.queryByRole('button'))).toBe(false)
    expect(click.defaultPrevented).toBe(false)
    expect(parentClick).toHaveBeenCalledTimes(1)
  })

  it('synchronizes ResizeObserver changes and disconnects on unmount', () => {
    const layout = { scrollHeight: 100, clientHeight: 50 }
    stubLayout(() => layout.scrollHeight, () => layout.clientHeight)
    const observer = installResizeObserver()

    const { unmount } = render(
      <ExpandableDescription
        description="長い説明テキスト"
        detailHref="/collection/streamer-1/card/card-1"
      />
    )

    layout.scrollHeight = 50
    layout.clientHeight = 50
    observer.notify()
    expect(screen.queryByRole('button', { name: /expand/ })).not.toBeInTheDocument()

    layout.scrollHeight = 100
    layout.clientHeight = 50
    observer.notify()
    const button = screen.getByRole('button', { name: /expand/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    observer.notify()
    expect(screen.getByRole('button', { name: /collapse/ })).toHaveAttribute('aria-expanded', 'true')

    unmount()
    expect(observer.disconnect).toHaveBeenCalled()
  })

  it('resets expansion after A to B to A description replacement', () => {
    const layout = { scrollHeight: 100, clientHeight: 50 }
    stubLayout(() => layout.scrollHeight, () => layout.clientHeight)
    const { rerender } = render(
      <ExpandableDescription description="説明A" />
    )

    fireEvent.click(screen.getByRole('button', { name: /expand/ }))
    expect(screen.getByRole('button', { name: /collapse/ })).toHaveAttribute('aria-expanded', 'true')

    layout.scrollHeight = 50
    layout.clientHeight = 50
    rerender(<ExpandableDescription description="説明B" />)

    layout.scrollHeight = 100
    layout.clientHeight = 50
    rerender(<ExpandableDescription description="説明A" />)

    expect(screen.getByRole('button', { name: /expand/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /collapse/ })).not.toBeInTheDocument()
  })
})
