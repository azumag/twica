import { describe, expect, it } from 'vitest'
import { hasAnnouncementBeenPublishedAt, isAnnouncementVisibleAt } from '@/lib/announcements'

describe('isAnnouncementVisibleAt', () => {
  const now = new Date('2026-03-10T12:00:00.000Z')

  it('期限切れのお知らせを非表示にする', () => {
    expect(
      isAnnouncementVisibleAt(
        {
          published_at: '2026-03-09T12:00:00.000Z',
          expires_at: '2026-03-10T11:59:59.000Z',
        },
        now
      )
    ).toBe(false)
  })

  it('公開時刻前のお知らせを非表示にする', () => {
    expect(
      isAnnouncementVisibleAt(
        {
          published_at: '2026-03-10T12:00:01.000Z',
          expires_at: null,
        },
        now
      )
    ).toBe(false)
  })

  it('公開期間内のお知らせを表示する', () => {
    expect(
      isAnnouncementVisibleAt(
        {
          published_at: '2026-03-09T12:00:00.000Z',
          expires_at: '2026-03-11T12:00:00.000Z',
        },
        now
      )
    ).toBe(true)
  })

  it('不正な日時を持つお知らせを非表示にする', () => {
    expect(
      isAnnouncementVisibleAt(
        {
          published_at: 'invalid-date',
          expires_at: null,
        },
        now
      )
    ).toBe(false)
  })
})

describe('hasAnnouncementBeenPublishedAt', () => {
  const now = new Date('2026-03-10T12:00:00.000Z')

  it('期限切れでも公開済みなら履歴ページには残す', () => {
    expect(
      hasAnnouncementBeenPublishedAt(
        {
          published_at: '2026-03-09T12:00:00.000Z',
        },
        now
      )
    ).toBe(true)
  })

  it('公開前のお知らせは履歴ページにも表示しない', () => {
    expect(
      hasAnnouncementBeenPublishedAt(
        {
          published_at: '2026-03-10T12:00:01.000Z',
        },
        now
      )
    ).toBe(false)
  })
})
