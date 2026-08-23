from pathlib import Path

page_path = Path('src/app/overlay/[streamerId]/page.tsx')
page = page_path.read_text()

old = '''  shouldPlaySound?: boolean;
  rewardId?: string | null;
}'''
new = '''  shouldPlaySound?: boolean;
  rewardId?: string | null;
  /** Monotonic per-overlay key so consecutive draws always remount card DOM. */
  displayInstanceId?: number;
}'''
if old not in page:
    raise SystemExit('GachaResult target not found')
page = page.replace(old, new, 1)

old = '''  const queueRef = useRef<GachaResult[]>([]);
  const isDisplayingRef = useRef(false);'''
new = '''  const queueRef = useRef<GachaResult[]>([]);
  // A card id can repeat within one draw. Give every queued display its own key
  // so React cannot reuse the previous card image while a new src is decoding.
  const displayInstanceSequenceRef = useRef(0);
  const isDisplayingRef = useRef(false);'''
if old not in page:
    raise SystemExit('queue ref target not found')
page = page.replace(old, new, 1)

old = '''        cards: undefined,
        shouldPlaySound: index === soundBearingIndex,
      }))'''
new = '''        cards: undefined,
        shouldPlaySound: index === soundBearingIndex,
        displayInstanceId: ++displayInstanceSequenceRef.current,
      }))'''
if old not in page:
    raise SystemExit('enqueue mapping target not found')
page = page.replace(old, new, 1)

old = '''      <div
        className={`transform transition-all duration-500 ${'''
new = '''      <div
        key={result.displayInstanceId ?? `${result.historyId ?? "card"}:${result.card.id}`}
        className={`transform transition-all duration-500 ${'''
if old not in page:
    raise SystemExit('card transition container target not found')
page = page.replace(old, new, 1)
page_path.write_text(page)

test_path = Path('tests/unit/components/overlay-page.test.tsx')
test = test_path.read_text()
marker = "  it('表示前に取得できた現行カードmetadataをautoPortraitとsmallModeへ反映する', async () => {"
if marker not in test:
    raise SystemExit('test insertion marker not found')
insert = '''  it('同じcard idが連続しても表示ごとに画像DOMを再マウントする', async () => {
    vi.useFakeTimers()

    class ImmediateImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 640
      height = 480

      set src(value: string) {
        void value
        setTimeout(() => this.onload?.(), 0)
      }
    }
    vi.stubGlobal('Image', ImmediateImage)

    let onGachaResult: ((payload: GachaBroadcastPayload) => void) | undefined
    subscribeMock.mockImplementation((_streamerId, callback, options: SubscribeOptions) => {
      onGachaResult = callback as (payload: GachaBroadcastPayload) => void
      options.onSuccess?.()
      return vi.fn()
    })

    render(<OverlayPage />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      onGachaResult?.({
        type: 'gacha',
        card: {
          id: 'same-card', name: 'Same Alpha', description: null,
          image_url: 'https://example.com/alpha.png', rarity: 'common',
        },
        cards: [
          {
            id: 'same-card', name: 'Same Alpha', description: null,
            image_url: 'https://example.com/alpha.png', rarity: 'common',
          },
          {
            id: 'same-card', name: 'Same Beta', description: null,
            image_url: 'https://example.com/beta.png', rarity: 'rare',
          },
        ],
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    const firstImage = screen.getByAltText('Same Alpha')
    expect(firstImage).toBeVisible()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    const secondImage = screen.getByAltText('Same Beta')
    expect(secondImage).toBeVisible()
    expect(secondImage).not.toBe(firstImage)
  })

'''
test_path.write_text(test.replace(marker, insert + marker, 1))
