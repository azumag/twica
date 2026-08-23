from pathlib import Path

page_path = Path('src/app/overlay/[streamerId]/page.tsx')
page = page_path.read_text()
page = page.replace(
'''const IMAGE_METADATA_TIMEOUT_MS = 1_500;''',
'''const IMAGE_METADATA_TIMEOUT_MS = 1_500;
const MIN_REVEAL_LEAD_IN_MS = 100;''',
1,
)
old = '''      const revealNotBefore = Date.now() + 100;
      // `result`を先に確定する。エフェクト設定はpresentation-onlyなので、
      // 解決に失敗してもbusiness eventのカードDOMを失わせない。
      setResult(next);
      setShowCard(false);

      try {'''
new = '''      // `result`を先に確定する。エフェクト設定はpresentation-onlyなので、
      // 解決に失敗してもbusiness eventのカードDOMを失わせない。
      setResult(next);
      setShowCard(false);

      try {'''
if old not in page:
    raise SystemExit('revealNotBefore block not found')
page = page.replace(old, new, 1)
old = '''      // The card DOM is mounted immediately, but the visible reveal waits for
      // metadata or the bounded probe timeout (whichever comes first), while
      // retaining a minimum 100ms animation lead-in. This preserves the
      // autoPortrait/smallMode decision without replacing a visible subtree.
      void imageMetadataPromise
        .then(() => {
          runProtected(() => {
            // Cleanup can resolve the metadata Promise. Re-check the queue
            // generation before scheduling any timer so an obsolete chain cannot
            // create work after cleanup has already cleared the previous timer.
            if (
              !isOverlayMountedRef.current
              || queueGeneration !== queueGenerationRef.current
            ) {
              return;
            }
            const revealDelay = Math.max(0, revealNotBefore - Date.now());
            animationTimeoutRef.current = setTimeout(() => runProtected(() => {
              if (
                !isOverlayMountedRef.current
                || queueGeneration !== queueGenerationRef.current
              ) {
                // Lifecycle cleanup owns the display-lock reset. An obsolete
                // chain must never unlock a newer subscription's active queue.
                return;
              }
              setShowCard(true);
              if (next.shouldPlaySound !== false) {
                if (next.soundGroupId) {
                  if (!playedSoundGroupIdsRef.current.has(next.soundGroupId)) {
                    playedSoundGroupIdsRef.current.add(next.soundGroupId);
                    playGachaSound(next);
                  }
                } else {
                  playGachaSound(next);
                }
              }

              // Hide after display, then process next queued item
              animationTimeoutRef.current = setTimeout(() => runProtected(() => {
                setShowCard(false);
                animationTimeoutRef.current = setTimeout(() => runProtected(() => {
                  // Once the outgoing card is removed, its callbacks must not affect
                  // the next card even if the browser retained the Image object.
                  imageLayoutGenerationRef.current += 1;
                  setResult(null);
                  // ref経由で最新のprocessQueueを呼び出し（再帰）
                  processQueueRef.current();
                }), 500);
              }), options.displayDuration * 1000);
            }), revealDelay);
          });
        })
        .catch(handleQueueError);'''
new = '''      // Mount the card DOM immediately. Metadata may choose portrait/small
      // layout before reveal, but queue liveness does not depend solely on the
      // metadata Promise: an independent fallback schedules reveal after the same
      // bounded probe window even if that Promise stops settling in a future
      // refactor. Whichever path wins still gives the final DOM branch at least
      // MIN_REVEAL_LEAD_IN_MS before it becomes visible.
      let revealScheduled = false;
      const scheduleReveal = () => {
        if (revealScheduled) return;
        if (
          !isOverlayMountedRef.current
          || queueGeneration !== queueGenerationRef.current
        ) {
          return;
        }
        revealScheduled = true;
        animationTimeoutRef.current = setTimeout(() => runProtected(() => {
          if (
            !isOverlayMountedRef.current
            || queueGeneration !== queueGenerationRef.current
          ) {
            // Lifecycle cleanup owns the display-lock reset. An obsolete
            // chain must never unlock a newer subscription's active queue.
            return;
          }
          setShowCard(true);
          if (next.shouldPlaySound !== false) {
            if (next.soundGroupId) {
              if (!playedSoundGroupIdsRef.current.has(next.soundGroupId)) {
                playedSoundGroupIdsRef.current.add(next.soundGroupId);
                playGachaSound(next);
              }
            } else {
              playGachaSound(next);
            }
          }

          // Hide after display, then process next queued item
          animationTimeoutRef.current = setTimeout(() => runProtected(() => {
            setShowCard(false);
            animationTimeoutRef.current = setTimeout(() => runProtected(() => {
              // Once the outgoing card is removed, its callbacks must not affect
              // the next card even if the browser retained the Image object.
              imageLayoutGenerationRef.current += 1;
              setResult(null);
              // ref経由で最新のprocessQueueを呼び出し（再帰）
              processQueueRef.current();
            }), 500);
          }), options.displayDuration * 1000);
        }), MIN_REVEAL_LEAD_IN_MS);
      };
      const metadataFallbackTimeout = setTimeout(
        () => runProtected(scheduleReveal),
        IMAGE_METADATA_TIMEOUT_MS,
      );
      void imageMetadataPromise
        .then(() => {
          clearTimeout(metadataFallbackTimeout);
          runProtected(scheduleReveal);
        })
        .catch(handleQueueError);'''
if old not in page:
    raise SystemExit('old reveal chain not found')
page = page.replace(old, new, 1)
page_path.write_text(page)

test_path = Path('tests/unit/components/overlay-page.test.tsx')
test = test_path.read_text()
test = test.replace(
"it('画像メタデータ取得が停止しても、タイムアウトを待たずN連キューを表示する', async () => {",
"it('画像メタデータ取得が停止しても、独立fallbackでN連キューを前進する', async () => {",
1,
)
test = test.replace(
'''    // 1枚目の表示終了後、2枚目のmetadata probeは無応答のままでも、カードDOMは
    // 先にマウントされる。visible revealだけは1.5秒のprobe上限まで待つ。''',
'''    // 1枚目の表示終了後、2枚目のmetadata probeは無応答のままでも、カードDOMは
    // 先にマウントされる。独立fallbackが1.5秒でrevealを予約し、最終DOMへ
    // 100msのlead-inを確保してから可視化する。''',
1,
)
test = test.replace(
'''    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(betaText.closest('.transition-all')).toHaveClass('opacity-100')''',
'''    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600)
    })
    expect(betaText.closest('.transition-all')).toHaveClass('opacity-100')''',
1,
)
test_path.write_text(test)
