import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(process.cwd(), 'db/planetscale/migrations/20260912013000_paced_multi_draw_chat.sql'),
  'utf8',
)

describe('paced multi-draw chat migration', () => {
  it('keeps existing streamers and existing outbox rows on summary mode', () => {
    expect(migration).toContain("delivery_mode text NOT NULL DEFAULT 'summary'")
    expect(migration).toContain('delivery_chunk_size integer NOT NULL DEFAULT 3')
    expect(migration).toContain('delivery_cursor integer NOT NULL DEFAULT 0')
  })

  it('constrains persisted delivery modes, chunk sizes, and cursor', () => {
    expect(migration).toContain("CHECK (delivery_mode IN ('summary', 'individual', 'chunked'))")
    expect(migration).toContain('CHECK (chunk_size BETWEEN 2 AND 5)')
    expect(migration).toContain('CHECK (delivery_cursor >= 0)')
  })

  it('snapshots streamer delivery settings into each transactional outbox row', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.snapshot_chat_outbox_delivery_settings()')
    expect(migration).toContain("NEW.payload #>> '{streamer,id}'")
    expect(migration).toContain('BEFORE INSERT ON public.chat_notification_outbox')
    expect(migration).toContain('NEW.delivery_cursor := 0')
  })

  it('keeps settings runtime-only and grants service_role access', () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.streamer_chat_multi_delivery_settings FROM PUBLIC, anon, authenticated',
    )
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.streamer_chat_multi_delivery_settings TO service_role',
    )
  })
})
