from pathlib import Path

page_path = Path('src/app/overlay/[streamerId]/page.tsx')
page = page_path.read_text()

old = '''// OBS Browser Source may keep a large animated image request pending without
// firing either `load` or `error`. Aspect-ratio detection is presentation-only,
// so it must never hold the business-event queue indefinitely. After this
// bounded wait the card renders with the normal landscape layout; a slow image
// may continue loading in the actual card element without blocking later draws.
const IMAGE_METADATA_TIMEOUT_MS = 1_500;
'''
new = '''// OBS Browser Source may keep a large animated image metadata request pending
// without firing either `load` or `error`. Aspect-ratio detection is
// presentation-only, so this timeout bounds the probe lifetime/layout decision;
// the business-event queue and card DOM mounting do not wait for it.
const IMAGE_METADATA_TIMEOUT_MS = 1_500;
'''
assert old in page
page = page.replace(old, new, 1)

old = '''      // Issue #1076: aspect-ratio detection is presentation-only. In OBS/CEF a
      // `new Image()` metadata request (and even its timeout) can be delayed,
      // so awaiting it here kept `result` null after a valid realtime payload
      // and produced a black overlay. Start the probe asynchronously and render
      // the card on the normal 100ms path regardless of metadata availability.
'''
new = '''      // Issue #1076: the exact OBS/CEF root cause is still unconfirmed. The real
      // preview path received a valid gacha payload but produced no card DOM/
      // pixels. Image metadata is presentation-only, so a business event must not
      // depend on this preflight before mounting its DOM. Decouple the probe as a
      // defensive fix; the existing 1.5s probe timeout would normally bound the
      // old wait, so preview real-path validation remains mandatory after merge.
'''
assert old in page
page = page.replace(old, new, 1)

old = '''      animationTimeoutRef.current = setTimeout(() => runProtected(() => {
        setShowCard(true);
'''
new = '''      animationTimeoutRef.current = setTimeout(() => runProtected(() => {
        // Metadata may improve the hidden card during this initial 100ms window,
        // but must not reflow a card after it becomes visible. Invalidate this
        // card's probe generation at reveal time so later load/timeout callbacks
        // are ignored; the next queued card allocates a fresh generation.
        if (imageLayoutGenerationRef.current === imageLayoutGeneration) {
          imageLayoutGenerationRef.current += 1;
        }
        setShowCard(true);
'''
assert old in page
page = page.replace(old, new, 1)
page_path.write_text(page)

test_path = Path('tests/unit/components/overlay-page.test.tsx')
test = test_path.read_text()
marker = '''  // Issue #999調査メモ: 「onerrorが正しく解決されず表示がブロックされて
'''
assert marker in test
insert = '''  it('表示前に取得できた現行カードmetadataをautoPortraitとsmallModeへ反映する', async () => {
    vi.useFakeTimers()

    class MockImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      width = 200
      height = 300

      set src(value: string) {
        void value
        setTimeout(() => this.onload?.(), 0)
      }
    }
    vi.stubGlobal('Image', MockImage)

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
          id: 'portrait-small-card',
          name: 'Portrait Small',
          description: null,
          image_url: 'https://example.com/portrait-small.png',
          rarity: 'rare',
        },
        userTwitchUsername: 'Viewer',
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    // metadata は reveal 前に解決したため、初回の可視フレームから image-only
    // (autoPortrait) かつ縮小サイズ (smallMode) で描画される。
    const cardImage = screen.getByAltText('Portrait Small')
    expect(cardImage).toBeVisible()
    expect(cardImage).toHaveClass('max-w-[192px]')
    expect(screen.queryByText('Viewer が引いたカード')).not.toBeInTheDocument()
  })

'''
test = test.replace(marker, insert + marker, 1)
test_path.write_text(test)
