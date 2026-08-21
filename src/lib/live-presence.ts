import "server-only";

import { getKvBinding } from "@/lib/cloudflare-kv";
import { createPublishSignature } from "@/lib/overlay-realtime/signature";
import { reportError } from "@/lib/sentry/error-handler";

/**
 * overlay presence ベースの推定配信チャネル数（#1114）。
 *
 * overlay realtime Worker の PresenceRegistry DOが保持する「最近接続を報告した
 * room数」の短期スナップショットを取得する。Twitchの正確な配信状態ではなく、
 * 推定値であることをUI文言で明示すること。
 *
 * 障害時方針: registry/署名/ネットワークの失敗は throw せず ok:false を返す。
 * /live は推定行の描画だけを省き、既存の一覧・ランキングは500にしない。
 * 成功スナップショットのみをKV(60秒)/メモリへキャッシュし、失敗時に0と
 * 誤表示しない（#1114 受け入れ条件）。
 */

export type EstimatedLiveChannelCount =
  | { ok: true; count: number }
  | { ok: false };

const LIVE_PRESENCE_KV_KEY = "live-presence:v1";
const LIVE_PRESENCE_TTL_SECONDS = 60;
const PRESENCE_PRESENCE_COUNT_PATH = "/internal/v1/presence-count";
const PRESENCE_COUNT_TIMEOUT_MS = 1_500;

/** KV なし環境（ローカル next dev / Vitest）用のメモリキャッシュ。 */
let memoryCache: { count: number; expiresAt: number } | null = null;

interface OverlayRealtimePresenceEnvironment {
  /** do-primary 以外ではroom自体が存在しないため、推定表示も行わない。 */
  realtimeMode: string | undefined;
  publishUrl: string | undefined;
  publishSecret: string | undefined;
  presenceService: { fetch(request: Request): Promise<Response> } | undefined;
}

function stringBinding(
  env: Record<string, unknown>,
  key: keyof NodeJS.ProcessEnv
): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * publisher.ts と同じ優先順位でWorkers実行環境の設定スナップショットを読む。
 * バインディングは1つのatomic設定として扱い、回転済みsecretと古いURLの混在を
 * 避ける。理由の詳細は publisher.ts の getPublisherEnvironment を参照。
 */
async function getPresenceEnvironment(): Promise<OverlayRealtimePresenceEnvironment> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    const runtimeEnv = env as unknown as Record<string, unknown>;
    const service = runtimeEnv.OVERLAY_REALTIME_SERVICE;
    return {
      realtimeMode: stringBinding(runtimeEnv, "OVERLAY_REALTIME_MODE"),
      publishUrl: stringBinding(runtimeEnv, "OVERLAY_REALTIME_PUBLISH_URL"),
      publishSecret: stringBinding(runtimeEnv, "OVERLAY_REALTIME_PUBLISH_SECRET"),
      presenceService:
        service && typeof service === "object" && "fetch" in service && typeof service.fetch === "function"
          ? (service as { fetch(request: Request): Promise<Response> })
          : undefined,
    };
  } catch {
    // next dev / Vitest にはOpenNextリクエストコンテキストがないため、
    // プロセスローカルのenvへフォールバックする。
    return {
      realtimeMode: process.env.OVERLAY_REALTIME_MODE,
      publishUrl: process.env.OVERLAY_REALTIME_PUBLISH_URL,
      publishSecret: process.env.OVERLAY_REALTIME_PUBLISH_SECRET,
      presenceService: undefined,
    };
  }
}

/** 公開レスポンスはcountだけを使う。未知フィールドはRSC payloadへ流さない。 */
function normalizePresenceCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.estimatedRooms === "number" &&
    Number.isSafeInteger(row.estimatedRooms) &&
    row.estimatedRooms >= 0
    ? row.estimatedRooms
    : null;
}

function resolvePresenceUrl(base: string | undefined): URL | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
      return null;
    }
    url.pathname = PRESENCE_PRESENCE_COUNT_PATH;
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

/**
 * 推定配信中チャネル数の短期キャッシュ付きスナップショット。
 *
 * 失敗時は既存キャッシュが有効な間だけそれを返し、無ければ ok:false。
 * 障害中に「0」と誤表示しないため、失敗でキャッシュを上書きしない。
 * 単一attempt（再試行なし）: 60秒キャッシュが瞬断を吸収する前提のため、
 * /live のTTFBを引き延ばす再試行は行わない。
 */
export async function getEstimatedLiveChannelCount(): Promise<EstimatedLiveChannelCount> {
  if (memoryCache && memoryCache.expiresAt > Date.now()) {
    return { ok: true, count: memoryCache.count };
  }

  try {
    const kv = await getKvBinding();
    if (kv) {
      const raw = await kv.get(LIVE_PRESENCE_KV_KEY);
      if (raw) {
        const count = normalizePresenceCount(JSON.parse(raw));
        if (count !== null) {
          memoryCache = {
            count,
            expiresAt: Date.now() + LIVE_PRESENCE_TTL_SECONDS * 1000,
          };
          return { ok: true, count };
        }
      }
    }
  } catch (error) {
    await reportError(
      error instanceof Error ? error : new Error(String(error)),
      { context: "livePresence:kvRead" },
    );
  }

  const env = await getPresenceEnvironment();
  // do-primary 以外（polling-only等）ではroomが存在せず、0件が「誰も配信して
  // いない」と誤読される。そのため機能無効時は非表示（ok:false）に倒す。
  if (env.realtimeMode !== "do-primary") {
    return { ok: false };
  }
  const url = resolvePresenceUrl(env.publishUrl);
  if (!url || !env.publishSecret) {
    return { ok: false };
  }

  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  // GETのためbodyは空文字。Worker側も同じcanonical（空bodyダイジェスト）で検証する。
  const body = "";
  const signature = await createPublishSignature(
    env.publishSecret,
    url.pathname,
    body,
    timestamp,
    nonce
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRESENCE_COUNT_TIMEOUT_MS);
  try {
    const requestInit: RequestInit = {
      method: "GET",
      headers: {
        "x-twica-timestamp": timestamp,
        "x-twica-nonce": nonce,
        "x-twica-signature": signature,
      },
      signal: controller.signal,
    };
    // Cloudflareの同一zone内Worker間はglobal fetch不可のため、Service Bindingが
    // 正規経路。global fetch はnext dev/Vitest用のフォールバック。
    const response = env.presenceService
      ? await env.presenceService.fetch(new Request(url, requestInit))
      : await fetch(url, requestInit);
    if (!response.ok) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // 未読ボディの解放はベストエフォート。
        }
      }
      return { ok: false };
    }
    const payload: unknown = await response.json();
    const count = normalizePresenceCount(payload);
    if (count === null) {
      return { ok: false };
    }

    try {
      const kv = await getKvBinding();
      if (kv) {
        await kv.put(LIVE_PRESENCE_KV_KEY, JSON.stringify({ estimatedRooms: count }), {
          expirationTtl: LIVE_PRESENCE_TTL_SECONDS,
        });
      }
    } catch (error) {
      await reportError(
        error instanceof Error ? error : new Error(String(error)),
        { context: "livePresence:kvWrite" },
      );
    }
    memoryCache = {
      count,
      expiresAt: Date.now() + LIVE_PRESENCE_TTL_SECONDS * 1000,
    };
    return { ok: true, count };
  } catch {
    // registry障害・タイムアウト。既存の/live表示は500にせず推定行を隠す。
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

/** テスト専用: メモリキャッシュをリセットする。 */
export function __resetLivePresenceCacheForTests(): void {
  memoryCache = null;
}
