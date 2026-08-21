import "server-only";

import { getKvBinding } from "@/lib/cloudflare-kv";
import {
  resolveOverlayRealtimeEnvironment,
} from "@/lib/overlay-realtime/runtime-env";
import { createPublishSignature } from "@/lib/overlay-realtime/signature";

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
 * 誤表示しない。加えて失敗も短時間ネガティブキャッシュし、registry障害中の
 * /live全リクエストに署名生成+サブリクエストとタイムアウト待ちが乗ることを
 * 防ぐ（自動レビュー指摘対応）。
 */

export type EstimatedLiveChannelCount =
  | { ok: true; count: number }
  | { ok: false };

const LIVE_PRESENCE_KV_KEY = "live-presence:v1";
const LIVE_PRESENCE_TTL_SECONDS = 60;
const PRESENCE_COUNT_PATH = "/internal/v1/presence-count";
const PRESENCE_COUNT_TIMEOUT_MS = 1_500;
/** 失敗後この時間内の再試行を行わない（TTFB保護）。 */
const NEGATIVE_CACHE_TTL_MS = 10_000;

interface LivePresenceCache {
  count: number;
  expiresAt: number;
}

/** KV なし環境（ローカル next dev / Vitest）用のメモリキャッシュ。 */
let memoryCache: LivePresenceCache | null = null;
let negativeCacheUntil = 0;

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
    url.pathname = PRESENCE_COUNT_PATH;
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
 * publisher.ts と同一のフェイルクローズ不変条件に従う:
 * - 本番でコンテキスト喪失時は process.env へ落ちず全undefined（共有resolver）。
 * - Workers runtime では Service Binding が無ければ global fetch へフォール
 *   バックしない。Binding欠如のまま古いビルド時URLへ叩くと、previewの推定値を
 *   本番 /live が表示しかねないため（自動レビュー必須指摘）。
 * - 失敗時は既存キャッシュが有効な間だけそれを返し、無ければ ok:false。
 *   失敗でキャッシュを上書きしないため「0」と誤表示しない。
 */
export async function getEstimatedLiveChannelCount(): Promise<EstimatedLiveChannelCount> {
  const now = Date.now();
  if (memoryCache && memoryCache.expiresAt > now) {
    return { ok: true, count: memoryCache.count };
  }

  try {
    const kv = await getKvBinding();
    if (kv) {
      const raw = await kv.get(LIVE_PRESENCE_KV_KEY);
      if (raw) {
        // 壊れたKV値のパース失敗で公開ページ経由のDB書き込み(reportError)を
        // 起こさない。ログ抑制のみで継続する（自動レビュー任意指摘対応）。
        const count = normalizePresenceCount(JSON.parse(raw));
        if (count !== null) {
          memoryCache = { count, expiresAt: now + LIVE_PRESENCE_TTL_SECONDS * 1000 };
          return { ok: true, count };
        }
      }
    }
  } catch (error) {
    console.warn("[livePresence] snapshot cache read failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }

  if (now < negativeCacheUntil) {
    return { ok: false };
  }

  const env = await resolveOverlayRealtimeEnvironment();
  const failClosed =
    // do-primary 以外（polling-only等）ではroom自体が存在せず、0件が
    // 「誰も配信していない」と誤読されるため非表示に倒す。
    env.mode !== "do-primary" ||
    !env.publishSecret ||
    (() => {
      const url = resolvePresenceUrl(env.publishUrl);
      return !url;
    })();
  // Workers実行時はService Binding必須。global fetchへのフォールバックは
  // dev/Vitestに限る（publisherと同じ不変条件）。
  const missingService = env.runtime === "workers" && !env.service;
  if (failClosed || missingService) {
    return { ok: false };
  }
  const url = resolvePresenceUrl(env.publishUrl)!;

  const timestamp = String(now);
  const nonce = crypto.randomUUID();
  // GETのためbodyは空文字。Worker側も同じcanonical（空bodyダイジェスト）で検証する。
  const body = "";
  const signature = await createPublishSignature(
    env.publishSecret!,
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
    const response = env.service
      ? await env.service.fetch(new Request(url, requestInit))
      : await fetch(url, requestInit);
    if (!response.ok) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {
          // 未読ボディの解放はベストエフォート。
        }
      }
      negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
      return { ok: false };
    }
    const payload: unknown = await response.json();
    const count = normalizePresenceCount(payload);
    if (count === null) {
      negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
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
      console.warn("[livePresence] snapshot cache write failed", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
    memoryCache = { count, expiresAt: Date.now() + LIVE_PRESENCE_TTL_SECONDS * 1000 };
    return { ok: true, count };
  } catch {
    // registry障害・タイムアウト。既存の/live表示は500にせず推定行を隠す。
    negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

/** テスト専用: メモリキャッシュをリセットする。 */
export function __resetLivePresenceCacheForTests(): void {
  memoryCache = null;
  negativeCacheUntil = 0;
}
