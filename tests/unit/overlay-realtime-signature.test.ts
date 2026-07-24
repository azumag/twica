import { describe, expect, it } from 'vitest'
import {
  createPublishSignature,
  verifyPublishSignature,
} from '@/lib/overlay-realtime/signature'

describe('overlay realtime publish signature', () => {
  it('authenticates the exact path, body, timestamp, and nonce', async () => {
    const secret = 'test-secret-with-sufficient-entropy'
    const path = '/internal/v1/rooms/room-1/publish'
    const body = '{"schemaVersion":1}'
    const timestamp = '1784851200000'
    const nonce = '123e4567-e89b-42d3-a456-426614174000'
    const signature = await createPublishSignature(
      secret,
      path,
      body,
      timestamp,
      nonce
    )

    await expect(
      verifyPublishSignature(secret, path, body, timestamp, nonce, signature)
    ).resolves.toBe(true)
    await expect(
      verifyPublishSignature(secret, `${path}-other`, body, timestamp, nonce, signature)
    ).resolves.toBe(false)
    await expect(
      verifyPublishSignature(secret, path, `${body} `, timestamp, nonce, signature)
    ).resolves.toBe(false)
  })

  it('rejects malformed MACs without throwing', async () => {
    await expect(
      verifyPublishSignature('secret', '/publish', '{}', '1', 'nonce', 'not-hex')
    ).resolves.toBe(false)
  })
})
