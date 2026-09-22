import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  computeFollowupDelaySeconds,
  handleChatDeliveryMessage,
  parseChatDeliveryWakeup,
  runChatDeliveryDueSweep,
} from '../../workers/chat-delivery/src/index';
import type { Env } from '../../workers/chat-delivery/src/index';

// Chat Delivery Queue Worker (Issue #1665) のpure/testable関数を検証する。
// workers/chat-delivery/src/index.ts はメインアプリと別のデプロイ単位・別tsconfig
// だが、tests/unit/error-reporter-worker.test.ts と同じ規約（相対importでそのまま
// importできる。vitestはesbuildでトランスパイルするため型チェックは行わず、
// ルートtsconfigに@cloudflare/workers-typesが無くても実行時には問題にならない）
// に従い、素の相対importで読み込む。

/** CHAT_APP.fetch / CHAT_NOTIFICATION_QUEUE.send をvi.fn()でモックした最小Envを作る。 */
function makeEnv(): Env {
  return {
    CHAT_APP: { fetch: vi.fn() },
    CHAT_NOTIFICATION_QUEUE: { send: vi.fn() },
    CHAT_APP_BASE_URL: 'https://chat-app.example.test',
    CHAT_DELIVERY_SECRET: 'dummy-secret',
  };
}

/** ack/retryをvi.fn()でモックした最小Queueメッセージを作る。 */
function makeMessage(body: unknown) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

/** env.CHAT_APP.fetchが返す成功レスポンスの最小スタブ。 */
function okResponse(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}

/** env.CHAT_APP.fetchが返す失敗レスポンスの最小スタブ。 */
function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

beforeEach(() => {
  // console.warnは内部endpoint失敗・enqueue失敗のたびに呼ばれる想定通りのログなので、
  // テスト出力を汚さないよう抑制する(error-reporter-worker.test.tsと同じ方針)。
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('parseChatDeliveryWakeup', () => {
  it('version=1・batchIdが文字列のvalid bodyをそのまま返す', () => {
    expect(parseChatDeliveryWakeup({ version: 1, batchId: 'abc' })).toEqual({
      version: 1,
      batchId: 'abc',
    });
  });

  it('versionが1以外ならnull', () => {
    expect(parseChatDeliveryWakeup({ version: 2, batchId: 'abc' })).toBeNull();
  });

  it('batchIdが無ければnull', () => {
    expect(parseChatDeliveryWakeup({ version: 1 })).toBeNull();
  });

  it('batchIdが空文字ならnull', () => {
    expect(parseChatDeliveryWakeup({ version: 1, batchId: '' })).toBeNull();
  });

  it('batchIdが文字列以外ならnull', () => {
    expect(parseChatDeliveryWakeup({ version: 1, batchId: 123 })).toBeNull();
  });

  it('batchIdが200文字を超えるならnull', () => {
    expect(parseChatDeliveryWakeup({ version: 1, batchId: 'a'.repeat(201) })).toBeNull();
  });

  it('batchIdがちょうど200文字なら通す(境界値)', () => {
    const batchId = 'a'.repeat(200);
    expect(parseChatDeliveryWakeup({ version: 1, batchId })).toEqual({ version: 1, batchId });
  });

  it('bodyがオブジェクトでない場合はnull(文字列)', () => {
    expect(parseChatDeliveryWakeup('abc')).toBeNull();
  });

  it('bodyがオブジェクトでない場合はnull(null)', () => {
    expect(parseChatDeliveryWakeup(null)).toBeNull();
  });

  it('bodyがオブジェクトでない場合はnull(配列)', () => {
    expect(parseChatDeliveryWakeup([])).toBeNull();
  });
});

describe('computeFollowupDelaySeconds', () => {
  const now = Date.parse('2026-09-22T00:00:00.000Z');

  it('nextAttemptAtがundefinedなら最小値(1秒)を返す', () => {
    expect(computeFollowupDelaySeconds(undefined, now)).toBe(1);
  });

  it('5000ms先のnextAttemptAtはceilした5秒を返す', () => {
    const nextAttemptAt = new Date(now + 5000).toISOString();
    expect(computeFollowupDelaySeconds(nextAttemptAt, now)).toBe(5);
  });

  it('過去のnextAttemptAtは負数にならず最小値(1秒)を返す', () => {
    const nextAttemptAt = new Date(now - 5000).toISOString();
    expect(computeFollowupDelaySeconds(nextAttemptAt, now)).toBe(1);
  });

  it('パース不能な日付文字列は最小値(1秒)を返す', () => {
    expect(computeFollowupDelaySeconds('not-a-date', now)).toBe(1);
  });

  it('上限(12*60*60秒)を超えるnextAttemptAtは上限にクランプする', () => {
    const MAX_FOLLOWUP_DELAY_SECONDS = 12 * 60 * 60;
    const nextAttemptAt = new Date(now + 100 * 60 * 60 * 1000).toISOString(); // 100時間先
    expect(computeFollowupDelaySeconds(nextAttemptAt, now)).toBe(MAX_FOLLOWUP_DELAY_SECONDS);
  });
});

describe('handleChatDeliveryMessage', () => {
  it('不正なmessage bodyはackしてCHAT_APP.fetchを呼ばない', async () => {
    const env = makeEnv();
    const message = makeMessage({ version: 1 }); // batchId欠如でparse失敗

    await handleChatDeliveryMessage(message as any, env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.CHAT_APP.fetch).not.toHaveBeenCalled();
  });

  it('outcome.kind=completeはackしてfollow-upをenqueueしない', async () => {
    const env = makeEnv();
    (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({ outcome: { kind: 'complete' } }),
    );
    const message = makeMessage({ version: 1, batchId: 'batch-complete' });

    await handleChatDeliveryMessage(message as any, env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.CHAT_NOTIFICATION_QUEUE.send).not.toHaveBeenCalled();
  });

  it('outcome.kind=deferredはfollow-up enqueue成功後にackする(enqueueがackより先)', async () => {
    const env = makeEnv();
    const nextAttemptAt = new Date(Date.now() + 5000).toISOString();
    (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({ outcome: { kind: 'deferred', nextAttemptAt } }),
    );
    (env.CHAT_NOTIFICATION_QUEUE.send as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const message = makeMessage({ version: 1, batchId: 'batch-deferred' });

    await handleChatDeliveryMessage(message as any, env);

    expect(env.CHAT_NOTIFICATION_QUEUE.send).toHaveBeenCalledTimes(1);
    const [sentMessage] = (env.CHAT_NOTIFICATION_QUEUE.send as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(sentMessage).toMatchObject({ version: 1, batchId: 'batch-deferred' });

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();

    // ackはfollow-up enqueue成功より後でなければならない(critical correctness property)。
    const sendOrder = (env.CHAT_NOTIFICATION_QUEUE.send as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const ackOrder = (message.ack as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(sendOrder).toBeLessThan(ackOrder);
  });

  it('follow-up enqueueが失敗したらretryしack しない(行を失わない)', async () => {
    const env = makeEnv();
    const nextAttemptAt = new Date(Date.now() + 5000).toISOString();
    (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      okResponse({ outcome: { kind: 'deferred', nextAttemptAt } }),
    );
    (env.CHAT_NOTIFICATION_QUEUE.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('queue send failed'),
    );
    const message = makeMessage({ version: 1, batchId: 'batch-enqueue-fail' });

    await handleChatDeliveryMessage(message as any, env);

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('CHAT_APP.fetch自体が失敗(ネットワークエラー)したらretryしackしない', async () => {
    const env = makeEnv();
    (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));
    const message = makeMessage({ version: 1, batchId: 'batch-network-error' });

    await handleChatDeliveryMessage(message as any, env);

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
    expect(env.CHAT_NOTIFICATION_QUEUE.send).not.toHaveBeenCalled();
  });

  it('内部endpointが5xxを返したらretryする', async () => {
    const env = makeEnv();
    (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(errorResponse(500));
    const message = makeMessage({ version: 1, batchId: 'batch-500' });

    await handleChatDeliveryMessage(message as any, env);

    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'lease_lost' },
    { kind: 'not_claimable' },
    { kind: 'terminal', code: 'x' },
  ])('outcome.kind=$kind はackしてfollow-upをenqueueしない(このWorkerからは完了扱い)', async (outcome) => {
    const env = makeEnv();
    (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse({ outcome }));
    const message = makeMessage({ version: 1, batchId: 'batch-terminal' });

    await handleChatDeliveryMessage(message as any, env);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(env.CHAT_NOTIFICATION_QUEUE.send).not.toHaveBeenCalled();
  });
});

describe('runChatDeliveryDueSweep', () => {
  it('CHAT_APP.fetchをaction: dispatch-due付きで呼び出す', async () => {
    const env = makeEnv();
    (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(okResponse({ outcome: null }));

    await runChatDeliveryDueSweep(env);

    expect(env.CHAT_APP.fetch).toHaveBeenCalledTimes(1);
    const [request] = (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(await (request as Request).text());
    expect(body.action).toBe('dispatch-due');
  });

  it('CHAT_APP.fetchがrejectしてもthrowしない', async () => {
    const env = makeEnv();
    (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));

    await expect(runChatDeliveryDueSweep(env)).resolves.toBeUndefined();
  });

  it('CHAT_APP.fetchが!okでもthrowしない', async () => {
    const env = makeEnv();
    (env.CHAT_APP.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(errorResponse(500));

    await expect(runChatDeliveryDueSweep(env)).resolves.toBeUndefined();
  });
});
