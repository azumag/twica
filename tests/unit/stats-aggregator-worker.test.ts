import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  STATS_REFRESH_CRON,
  callStatsRefreshForTarget,
  runScheduledRefresh,
  stripTrailingSlash,
} from '../../workers/stats-aggregator/src/index';
import type { Env } from '../../workers/stats-aggregator/src/index';

// Stats Aggregator Cron Worker (Issue #741) のpure/testable関数を検証する。
// tests/unit/chat-delivery-worker.test.ts と同じ規約 (相対importでそのまま
// importできる。vitestはesbuildでトランスパイルするため型チェックは行わず、
// ルートtsconfigに@cloudflare/workers-typesが無くても実行時には問題にならない)
// に従う。

function okResponse(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => '' };
}

function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({}), text: async () => `error ${status}` };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('stats-aggregator worker (Issue #741)', () => {
  it('keeps the cron definition in sync with wrangler.toml', () => {
    const wrangler = readFileSync('workers/stats-aggregator/wrangler.toml', 'utf8');

    expect(wrangler).toContain(`crons = ["${STATS_REFRESH_CRON}"]`);
  });

  it('holds no database binding (trigger-only worker)', () => {
    const wrangler = readFileSync('workers/stats-aggregator/wrangler.toml', 'utf8');

    expect(wrangler).not.toContain('[[hyperdrive]]');
    expect(wrangler).not.toContain('supabase');
    expect(wrangler).not.toContain('SUPABASE');
  });

  it('strips trailing slashes from the base URL', () => {
    expect(stripTrailingSlash('https://example.test///')).toBe('https://example.test');
    expect(stripTrailingSlash('https://example.test')).toBe('https://example.test');
  });

  it('POSTs to the internal refresh endpoint with the shared secret', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ skipped: false, reason: 'refreshed', snapshotCount: 7, computedAt: 'x', durationMs: 1 }),
    );

    await callStatsRefreshForTarget(
      { name: 'production', baseUrl: 'https://app.example.test', refreshSecret: 's3cret' },
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.example.test/api/internal/stats/refresh');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-stats-refresh-secret']).toBe('s3cret');
  });

  it('skips without fetch when the base URL or secret is missing', async () => {
    const fetchImpl = vi.fn();

    await callStatsRefreshForTarget(
      { name: 'preview', baseUrl: undefined, refreshSecret: 's3cret' },
      fetchImpl as unknown as typeof fetch,
    );
    await callStatsRefreshForTarget(
      { name: 'preview', baseUrl: 'https://app.example.test', refreshSecret: undefined },
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs non-2xx without throwing (next tick recovers)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(500));

    await expect(
      callStatsRefreshForTarget(
        { name: 'production', baseUrl: 'https://app.example.test', refreshSecret: 's3cret' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('logs network errors without throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      callStatsRefreshForTarget(
        { name: 'production', baseUrl: 'https://app.example.test', refreshSecret: 's3cret' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it('runs both targets independently (one failure does not stop the other)', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('prod down'))
      .mockResolvedValueOnce(
        okResponse({ skipped: true, reason: 'cooldown', snapshotCount: 0, computedAt: null, durationMs: 1 }),
      );
    const env: Env = {
      APP_BASE_URL_PROD: 'https://prod.example.test',
      APP_BASE_URL_PREVIEW: 'https://preview.example.test',
      STATS_REFRESH_SECRET_PROD: 'prod-secret',
      STATS_REFRESH_SECRET_PREVIEW: 'preview-secret',
    };

    await runScheduledRefresh(env, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
