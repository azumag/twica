import "server-only";

import { getKvBinding } from "@/lib/cloudflare-kv";
import {
  resolveOverlayRealtimeEnvironment,
  resolveRealtimeUrl,
} from "@/lib/overlay-realtime/runtime-env";
import { createPublishSignature } from "@/lib/overlay-realtime/signature";

/**
 * overlay presence ベースの推定配信チャネル数（#1114）。
 *
 * overlay realtime Worker の PresenceRegistry DOが保持する「最近接続を報告した
 * room数」の短期スナップショットを取得する。Twitchの正確な配信状態ではなく、
 * 推定値であることをUI文言で明示すること。
 *
 * 障害時方針: registry/署名/ネットワークの失敗は throw せず ok:false を返す
 * （署名生成も含めてtry内。ここがthrowするとPromise.all経由で公開/live全体が
 * 500になるため）。/live は推定行の描画だけを省き、既存の一覧・ランキングには
 * 影響しない。成功スナップショットのみをKV(60秒)/メモリへキャッシュし、失敗時に
 * 0と誤表示しない。加えて失敗も短時間ネガティブキャッシュし、registry障害中の
 * /live全リクエストに署名生成+サブリクエストとタイムアウト待ちが乗ることを防ぐ。
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
/** KVヒット時にメモリへ載せる最短TTL。残存TTLがこれ未満なら実フェッチする。 */
const MIN_MEMORY_TTL_MS = 5_000;

/** 成功スナップショットのメモリキャッシュ。 */
let memoryCache: { count: number; expiresAt: number } | null = null;
let negativeCacheUntil = 0;

interface PresenceSnapshotPayload {
  estimatedRooms?: unknown;
  /** 書込時刻(ms)。KVの残存TTLぶんの二重エージングを防ぐために使う。 */
  writtenAt?: unknown;
}

function normalizePresenceCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.estimatedRooms === "number" &&
    Number.isSafeInteger(row.estimatedRooms) &&
    row.estimatedRooms >= 0
    ? row.estimatedRooms
    : null;
}

/**
 * KVに保存したスナップショットを読み、残存TTLを考慮してメモリTTLを決める。
 *
 * KV TTL(60秒)とメモリ TTL(60秒)を単純に併用すると、書込から59秒経った値でも
 * 読んだisolateはさらに60秒保持し、合計約2分前の値を「現在」と表示してしまう
 * （自動レビュー任意指摘）。writtenAtから残存時間だけメモリへ載せて二重
 * エージングを防ぐ。
 */
function readCachedSnapshot(raw: string): number | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // 壊れたKV値による公開ページ経由のDB書き込み(reportError)を避けるため、
    // パース失敗はログのみで継続する。
    loggerWarn("snapshot cache parse failed");
    return null;
  }
  const count = normalizePresenceCount(payload);
  if (count === null) return null;

  const row = (payload ?? {}) as PresenceSnapshotPayload;
  const writtenAt =
    typeof row.writtenAt === "number" && Number.isSafeInteger(row.writtenAt)
      ? row.writtenAt
      : Date.now();
  const remainingMs =
    LIVE_PRESENCE_TTL_SECONDS * 1000 - (Date.now() - writtenAt);
  if (remainingMs < MIN_MEMORY_TTL_MS) return null;

  memoryCache = {
    count,
    expiresAt: Date.now() + Math.min(remainingMs, LIVE_PRESENCE_TTL_SECONDS * 1000),
  };
  return count;
}

/**
 * logger.server の warn はconsole出力のみでDB書き込みを行わないため、公開
 * ページのレンダリング経路から呼んでも安全。直接consoleを使うとprefixや
 * マスク規約から外れるため共有loggerへ統一する（自動レビュー任意指摘）。
 */
function loggerWarn(message: string, detail?: Record<string, unknown>): void {
  // 動的importにしない理由: server-onlyモジュールの静的依存はNext.jsの
  // サーバーバンドルでのみ解決され、本モジュール自身がserver-onlyのため常に成立する。
  void import("@/lib/logger.server").then(({ logger }) => {
    logger.warn(`[livePresence] ${message}`, detail);
  });
}

/**
 * 推定配信中チャネル数の短期キャッシュ付きスナップショット。
 *
 * publisher.ts と同一のフェイルクローズ不変条件に従う:
 * - 本番でコンテキスト喪失時は process.env へ落ちず全undefined（共有resolver）。
 * - Workers runtime では Service Binding が無ければ global fetch へフォール
 *   バックしない。Binding欠如のまま古いビルド時URLへ叩くと、previewの推定値を
 *   本番 /live が表示しかねないため。
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
        const count = readCachedSnapshot(raw);
        if (count !== null) {
          return { ok: true, count };
        }
      }
    }
  } catch (error) {
    loggerWarn("snapshot cache read failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }

  if (now < negativeCacheUntil) {
    return { ok: false };
  }

  const env = await resolveOverlayRealtimeEnvironment();
  // URLは1回だけ評価する（自動レビュー任意指摘: 二重評価とnon-null assertion解消）。
  const url = resolveRealtimeUrl(env.publishUrl, PRESENCE_COUNT_PATH);
  // Workers実行時はService Binding必須。global fetchへのフォールバックは
  // dev/Vitestに限る（publisherと同じ不変条件）。
  const missingService = env.runtime === "workers" && !env.service;
  if (
    // do-primary 以外（polling-only等）ではroom自体が存在せず、0件が
    // 「誰も配信していない」と誤読されるため非表示に倒す。
    env.mode !== "do-primary"
    || !env.publishSecret
    || !url
    || missingService
  ) {
    return { ok: false };
  }

  try {
    // 署名生成まで障害境界の内側。WebCrypto/UUID生成の失敗も公開ページを
    // 500にしない（自動レビュー必須指摘）。
    const timestamp = String(now);
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
          await kv.put(
            LIVE_PRESENCE_KV_KEY,
            JSON.stringify({ estimatedRooms: count, writtenAt: Date.now() }),
            { expirationTtl: LIVE_PRESENCE_TTL_SECONDS },
          );
        }
      } catch (error) {
        loggerWarn("snapshot cache write failed", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
      memoryCache = {
        count,
        expiresAt: Date.now() + LIVE_PRESENCE_TTL_SECONDS * 1000,
      };
      return { ok: true, count };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // 署名生成・ネットワーク・タイムアウトのいずれも推定行の非表示だけで復旧。
    negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
    return { ok: false };
  }
}

/** テスト専用: メモリキャッシュをリセットする。 */
export function __resetLivePresenceCacheForTests(): void {
  memoryCache = null;
  negativeCacheUntil = 0;
}
