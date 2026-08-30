import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../workers/error-reporter/src/index';

// Issue #1226: repository metadata validation must not move ahead of the
// EventSub health probe, otherwise a reporter-only configuration error can
// silently suppress subscription-health monitoring.
describe('error-reporter scheduled EventSub health before repository validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['GITHUB_REPO_OWNER', { GITHUB_REPO_OWNER: '', GITHUB_REPO_NAME: 'testrepo' }],
    ['GITHUB_REPO_NAME', { GITHUB_REPO_OWNER: 'testowner', GITHUB_REPO_NAME: '' }],
  ])('%s が未設定でも EventSub health を先に実行する', async (_missingKey, repository) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 2,
        unhealthyCount: 0,
        unhealthy: [],
        checkedAt: '2026-08-27T00:00:00.000Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const env = {
      HYPERDRIVE_PLANETSCALE: { connectionString: 'postgres://mock:mock@localhost:5432/mock' },
      GITHUB_TOKEN: 'gh-token',
      ...repository,
      APP_BASE_URL_PROD: 'https://prod.example.com/',
      EVENTSUB_HEALTH_SECRET_PROD: 'prod-health-secret',
    } as unknown as Parameters<typeof worker.scheduled>[1];
    const event = { cron: '*/5 * * * *' } as ScheduledController;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    await worker.scheduled(event, env, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://prod.example.com/api/admin/eventsub-health',
      expect.objectContaining({
        headers: { 'X-EventSub-Health-Secret': 'prod-health-secret' },
      })
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing GITHUB_REPO_OWNER'));
  });
});
