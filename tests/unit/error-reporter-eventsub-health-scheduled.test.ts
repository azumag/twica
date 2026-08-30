import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../workers/error-reporter/src/index';

describe('error-reporter scheduled EventSub health wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reporter用binding/secretsが未設定でもEventSub healthを先に実行する', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 2,
        unhealthyCount: 0,
        unhealthy: [],
        checkedAt: '2026-08-25T00:00:00.000Z',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const env = {
      GITHUB_TOKEN: '',
      GITHUB_REPO_OWNER: 'testowner',
      GITHUB_REPO_NAME: 'testrepo',
      APP_BASE_URL_PROD: 'https://prod.example.com/',
      EVENTSUB_HEALTH_SECRET_PROD: 'prod-health-secret',
    };
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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Missing required binding/secrets')
    );
  });
});
