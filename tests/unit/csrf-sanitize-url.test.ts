import { describe, expect, it } from 'vitest'
import { sanitizeURL } from '@/lib/csrf'

describe('sanitizeURL', () => {
  it('returns only the pathname for an absolute URL with query and fragment', () => {
    expect(sanitizeURL('https://example.com/private/path?token=secret#details')).toBe(
      '/private/path',
    )
  })

  it('preserves the root pathname', () => {
    expect(sanitizeURL('https://example.com/?token=secret')).toBe('/')
  })

  it('returns a safe fallback for malformed URLs', () => {
    expect(sanitizeURL('not-a-url')).toBe('[invalid URL]')
  })
})
