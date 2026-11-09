import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, {
  STORAGE_MAINTENANCE_CRON,
  callStorageMaintenanceForTarget,
  runScheduledStorageMaintenance,
} from '../../workers/error-reporter/src/index';
import type { Env } from '../../workers/error-reporter/src/index';

// Issue #1907: error-reporter Cron Worker に追加したストレージ保守トリガー。
// DB/Hyperdrive には触れず、アプリ本体の internal route を HTTP で叩くだけの
// 部分を検証する（既存の errors/inquiries テストとは分離）。

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    text: async () => `error ${status}`,
  };
}

const baseEnv: Env = {
  GITHUB_TOKEN: 'token',
  GITHUB_REPO_OWNER: 'owner',
  GITHUB_REPO_NAME: 'repo',
  APP_BASE_URL_PROD: 'https://prod.example.test',
  APP_BASE_URL_PREVIEW: 'https://preview.example.test',
  STORAGE_MAINTENANCE_SECRET_PROD: 'prod-secret',
  STORAGE_MAINTENANCE_SECRET_PREVIEW: 'preview-secret',
};

describe('error-reporter storage maintenance trigger (#1907)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reconcile → collect-unused-sounds を共有シークレット付きで順に実行する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ changed: 0 }));

    await callStorageMaintenanceForTarget(
      { name: 'production', baseUrl: 'https://app.example.test/', secret: 's3cret' },
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://app.example.test/api/internal/storage-maintenance');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-storage-maintenance-secret']).toBe('s3cret');
    expect(JSON.parse(String(init.body))).toEqual({
      action: 'collect-unused-sounds',
      minAgeSeconds: 86_400,
      maxDeletions: 200,
    });
    expect(JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body))).toEqual({
      action: 'reconcile',
    });
  });

  it('baseUrl / secret が無いターゲットは fetch せず skip する', async () => {
    const fetchImpl = vi.fn();

    await callStorageMaintenanceForTarget(
      { name: 'preview', baseUrl: undefined, secret: 's3cret' },
      fetchImpl as unknown as typeof fetch,
    );
    await callStorageMaintenanceForTarget(
      { name: 'preview', baseUrl: 'https://app.example.test', secret: undefined },
      fetchImpl as unknown as typeof fetch,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('アクション単位で非2xx/ネットワーク失敗を隔離する（次のアクションを止めない）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(500))
      .mockRejectedValueOnce(new Error('boom'));

    await expect(
      callStorageMaintenanceForTarget(
        { name: 'production', baseUrl: 'https://app.example.test', secret: 's3cret' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalled();
  });

  it('prod/preview の両方を独立に実行する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ changed: 0 }));

    await runScheduledStorageMaintenance(baseEnv, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const urls = fetchImpl.mock.calls.map((call) => call[0]);
    expect(urls).toContain('https://prod.example.test/api/internal/storage-maintenance');
    expect(urls).toContain('https://preview.example.test/api/internal/storage-maintenance');
  });

  it('scheduled() は専用 cron でストレージ保守だけを実行する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ changed: 0 }));
    vi.stubGlobal('fetch', fetchImpl);

    await worker.scheduled(
      { cron: STORAGE_MAINTENANCE_CRON } as ScheduledController,
      baseEnv,
      {} as ExecutionContext,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // 既存3処理の DB/GitHub 呼び出しへ落ちていないこと（GITHUB_TOKEN 等の
    // バリデーションより前に分岐して return する）。
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Missing required binding/secrets'),
    );
  });

  it('STORAGE_MAINTENANCE_CRON が wrangler.toml の crons に実在する（ドリフト検知）', () => {
    const wrangler = readFileSync(
      resolve(__dirname, '../../workers/error-reporter/wrangler.toml'),
      'utf8',
    );
    const cronsLine = wrangler.match(/^crons\s*=\s*\[(.+)\]/m);
    expect(cronsLine).not.toBeNull();
    const crons = (cronsLine?.[1] ?? '')
      .split(',')
      .map((value) => value.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
    expect(crons).toContain(STORAGE_MAINTENANCE_CRON);
  });
});
