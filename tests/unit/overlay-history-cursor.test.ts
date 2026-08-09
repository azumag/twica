import { describe, expect, it } from 'vitest'
import { normalizeOverlayHistoryTimestamp } from '@/lib/overlay-history-cursor'

describe('normalizeOverlayHistoryTimestamp', () => {
  it.each([
    ['2026-07-24T00:00:01Z', '2026-07-24T00:00:01Z'],
    ['2026-07-24T00:00:01.123456Z', '2026-07-24T00:00:01.123456Z'],
    ['2026-07-24T09:00:01.123456+09:00', '2026-07-24T00:00:01.123456Z'],
    // URLSearchParams can decode a literal plus into a space.
    ['2026-07-24T09:00:01.123456 09:00', '2026-07-24T00:00:01.123456Z'],
  ])('APIとbrowserで同じtimestampをcanonical UTCへ正規化する: %s', (raw, expected) => {
    expect(normalizeOverlayHistoryTimestamp(raw)).toBe(expected)
  })

  it.each([
    'July 24, 2026',
    '2026-07-24',
    '2026-02-30T00:00:00Z',
    '2026-07-24T00:00:00.1234567Z',
    '2026-07-24T00:00:00+24:00',
    '',
    null,
  ])('Date.parseが受理し得てもAPI文法外の値を拒否する: %s', (raw) => {
    expect(normalizeOverlayHistoryTimestamp(raw)).toBeNull()
  })
})
