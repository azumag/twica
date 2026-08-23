from pathlib import Path

page_path = Path('src/app/overlay/[streamerId]/page.tsx')
page = page_path.read_text()
sentinel = 'const imageLayoutGenerationRef = useRef(0);'
if sentinel in page:
    print('source patch already applied')
else:
    old = '''  // Image metadata checks are cancellable because their Promise is awaited by
  // the display queue. Cleanup must resolve (not merely clear) pending checks,
  // otherwise the suspended processQueue closure and its card remain retained.
  const activeImageCheckCancelsRef = useRef<Set<() => void>>(new Set());
  const isOverlayMountedRef = useRef(false);
  // A streamer change can reuse this component instance. The generation lets
  // an old async image check distinguish that transport cleanup from the new
  // subscription setup, even when the mounted flag has already become true.
  const queueGenerationRef = useRef(0);
'''
    new = '''  // Image metadata checks are presentation-only and run independently from the
  // display queue. Cleanup still resolves pending checks so Image callbacks do
  // not retain an obsolete card/component lifetime.
  const activeImageCheckCancelsRef = useRef<Set<() => void>>(new Set());
  const isOverlayMountedRef = useRef(false);
  // A streamer change can reuse this component instance. The queue generation
  // prevents an obsolete display task from continuing into the new subscription.
  const queueGenerationRef = useRef(0);
  // Image metadata can resolve after the card that started it has already been
  // replaced. Only the latest card may update portrait/small presentation state.
  const imageLayoutGenerationRef = useRef(0);
'''
    assert old in page
    page = page.replace(old, new, 1)

    old = '''  const checkImageAspectRatio = useCallback((imageUrl: string | null): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!imageUrl) {
        setIsPortraitImage(false);
        setIsSmallImage(false);
        resolve(false);
        return;
      }
'''
    new = '''  const checkImageAspectRatio = useCallback((
    imageUrl: string | null,
    imageLayoutGeneration: number,
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!imageUrl) {
        if (
          isOverlayMountedRef.current
          && imageLayoutGeneration === imageLayoutGenerationRef.current
        ) {
          setIsPortraitImage(false);
          setIsSmallImage(false);
        }
        resolve(false);
        return;
      }
'''
    assert old in page
    page = page.replace(old, new, 1)

    old = '''        if (updateLayout && isOverlayMountedRef.current) {
          setIsPortraitImage(isPortrait);
          setIsSmallImage(isSmall);
        }
'''
    new = '''        if (
          updateLayout
          && isOverlayMountedRef.current
          && imageLayoutGeneration === imageLayoutGenerationRef.current
        ) {
          setIsPortraitImage(isPortrait);
          setIsSmallImage(isSmall);
        }
'''
    assert old in page
    page = page.replace(old, new, 1)

    old = '''    try {
      // 画像のアスペクト比をチェック（autoPortraitモード用）
      await checkImageAspectRatio(next.card.image_url);
      if (
        !isOverlayMountedRef.current
        || queueGeneration !== queueGenerationRef.current
      ) {
        return;
      }

      // このカードのレアリティに紐づくエフェクトを解決する。
'''
    new = '''    try {
      // Issue #1076: aspect-ratio detection is presentation-only. In OBS/CEF a
      // `new Image()` metadata request (and even its timeout) can be delayed,
      // so awaiting it here kept `result` null after a valid realtime payload
      // and produced a black overlay. Start the probe asynchronously and render
      // the card on the normal 100ms path regardless of metadata availability.
      const imageLayoutGeneration = imageLayoutGenerationRef.current + 1;
      imageLayoutGenerationRef.current = imageLayoutGeneration;
      setIsPortraitImage(false);
      setIsSmallImage(false);
      void checkImageAspectRatio(
        next.card.image_url,
        imageLayoutGeneration,
      ).catch((error) => {
        // Metadata is optional presentation data; a probe failure must not drop
        // or advance the business-event queue after the card has started.
        logger.warn("Overlay image metadata probe failed:", error);
        addDebugLogRef.current(
          `image metadata probe failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      if (
        !isOverlayMountedRef.current
        || queueGeneration !== queueGenerationRef.current
      ) {
        return;
      }

      // このカードのレアリティに紐づくエフェクトを解決する。
'''
    assert old in page
    page = page.replace(old, new, 1)

    old = '''      isOverlayMountedRef.current = false;
      queueGenerationRef.current += 1;
      for (const cancel of [...activeImageCheckCancels]) {
'''
    new = '''      isOverlayMountedRef.current = false;
      queueGenerationRef.current += 1;
      imageLayoutGenerationRef.current += 1;
      for (const cancel of [...activeImageCheckCancels]) {
'''
    assert old in page
    page = page.replace(old, new, 1)
    page_path.write_text(page)

test_path = Path('tests/unit/components/overlay-page.test.tsx')
test = test_path.read_text()
old_title = "it('画像メタデータ取得が停止しても、タイムアウト後にN連キューを最後まで進める', async () => {"
new_title = "it('画像メタデータ取得が停止しても、タイムアウトを待たずN連キューを表示する', async () => {"
if new_title not in test:
    assert old_title in test
    test = test.replace(old_title, new_title, 1)

    old = '''    // 1枚目の表示終了後、2枚目の画像ロードは応答しない。切替の0.5秒後から
    // タイムアウト直前まで結果領域は空であり、2枚目が早まって表示されない。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6500 + 1499)
    })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.queryByText('Beta')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1 + 100)
    })
    expect(screen.getByText('Beta')).toBeInTheDocument()

    // 2枚目の表示終了後は3枚目の通常ロードへ戻り、無応答だった1枚によって
    // キューが恒久停止しない。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6500 + 100)
    })
    expect(screen.getByText('Gamma')).toBeInTheDocument()
'''
    new = '''    // 1枚目の表示終了後、2枚目のmetadata probeは無応答のまま。
    // それでもprobeの1.5秒timeoutを待たず、通常の表示間隔+100msでBetaが
    // 可視になることを固定する。これがIssue #1076の黒画面回帰契約。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeVisible()

    // 2枚目のmetadata timeoutの有無とは独立に通常の表示時間で3枚目へ進む。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6600)
    })
    expect(screen.getByText('Gamma')).toBeVisible()
'''
    assert old in test
    test = test.replace(old, new, 1)

    old = '''  // Issue #999 レビュー指摘#1回帰（GitHub自動レビュー・subagentレビュー
  // 双方が指摘): 上のテストは processQueue の外側の try/catch（await
  // checkImageAspectRatio 完了まで〜setResult/setShowCard まで）で捕捉
  // される例外だけを検証していた。しかし setTimeout でスケジュールされる
'''
    new = '''  // Issue #999 レビュー指摘#1回帰（GitHub自動レビュー・subagentレビュー
  // 双方が指摘): 上のテストは processQueue の外側の try/catch（metadata
  // probe開始〜setResult/setShowCard まで）で捕捉される例外だけを検証していた。
  // しかし setTimeout でスケジュールされる
'''
    assert old in test
    test = test.replace(old, new, 1)
    test_path.write_text(test)
else:
    print('test patch already applied')
