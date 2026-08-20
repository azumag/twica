// rate-limit は src/middleware.ts から到達し、Cloudflare Workers の Edge runtime でも
// 実行される。そのため DB 永続化を伴う logger.server を import してはならない。
// rate-limit の warn/error は Cloudflare Observability の Workers console logs だけを
// 記録先とする: middleware は全リクエスト前段で動くため、DB I/O を足すと Edge
// compatibility・遅延・障害時の fail-open 契約を同時に損なう。詳細な永続化が必要な
// server-only Route Handler は、その境界で logger.server を別途使用する。
import { logger } from "./logger";

/**
 * Rate limit store data structure
 * レート制限のストアデータ構造
 */
interface RateLimitStore {
  count: number;
  resetTime: number;
}

/**
 * Rate limit check result
 * レート制限チェック結果
 */
interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

/**
 * Rate limiter interface
 * レートリミッターインターフェース
 */
interface RateLimiter {
  limit: (identifier: string) => Promise<RateLimitResult>;
}

/**
 * Rate limit storage interface for pluggable backends
 * プラガブルなバックエンド用のレート制限ストレージインターフェース
 *
 * This abstraction allows switching between:
 * - MemoryRateLimitStorage: For development and Vercel (single instance)
 * - KVRateLimitStorage: For Cloudflare Workers (distributed)
 *
 * この抽象化により以下を切り替え可能:
 * - MemoryRateLimitStorage: 開発環境とVercel用（単一インスタンス）
 * - KVRateLimitStorage: Cloudflare Workers用（分散環境）
 */
export interface RateLimitStorage {
  get(key: string): Promise<RateLimitStore | null>;
  set(key: string, value: RateLimitStore, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Memory-based rate limit storage (for development and single-instance deployments)
 * メモリベースのレート制限ストレージ（開発環境と単一インスタンスデプロイ用）
 *
 * Note: This storage is not suitable for distributed environments like
 * Cloudflare Workers where multiple instances run simultaneously.
 *
 * 注意: このストレージは複数インスタンスが同時に動作する
 * Cloudflare Workersのような分散環境には適していません。
 */
class MemoryRateLimitStorage implements RateLimitStorage {
  private store = new Map<string, RateLimitStore>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Periodic cleanup to prevent memory leaks
    // メモリリークを防ぐための定期クリーンアップ
    if (typeof setInterval !== 'undefined') {
      this.cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, record] of this.store.entries()) {
          if (now > record.resetTime) {
            this.store.delete(key);
          }
        }
      }, 60 * 1000);
    }
  }

  async get(key: string): Promise<RateLimitStore | null> {
    return this.store.get(key) || null;
  }

  async set(key: string, value: RateLimitStore, _ttlMs: number): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  // For testing purposes
  clear(): void {
    this.store.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

/**
 * Cloudflare KV-based rate limit storage
 * Cloudflare KVベースのレート制限ストレージ
 *
 * This storage is designed for distributed environments where
 * multiple worker instances need to share rate limit state.
 *
 * このストレージは複数のワーカーインスタンスが
 * レート制限状態を共有する必要がある分散環境向けです。
 *
 * Usage in Cloudflare Workers:
 * ```typescript
 * // In your worker, get the KV namespace from the environment
 * const kvStorage = new KVRateLimitStorage(env.RATE_LIMIT_KV);
 * setRateLimitStorage(kvStorage);
 * ```
 */
export class KVRateLimitStorage implements RateLimitStorage {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get(key: string): Promise<RateLimitStore | null> {
    const value = await this.kv.get(key, 'json');
    return value as RateLimitStore | null;
  }

  async set(key: string, value: RateLimitStore, ttlMs: number): Promise<void> {
    // KV uses seconds for TTL, so convert from milliseconds
    // KVはTTLに秒を使用し、expirationTtlの最小値は60秒。rate-limit windowの
    // 終端では残り時間が1秒未満になるため、単純な切り上げだとCloudflareが
    // expirationTtl: 1を400で拒否し、レート制限がfail-openになる。
    const ttlSeconds = Math.max(60, Math.ceil(ttlMs / 1000));
    await this.kv.put(key, JSON.stringify(value), {
      expirationTtl: ttlSeconds,
    });
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}

/**
 * Cloudflare KV namespace type definition
 * Cloudflare KV名前空間の型定義
 *
 * This is a minimal type definition for Cloudflare KV.
 * In a real Cloudflare Workers project, you would use @cloudflare/workers-types.
 *
 * これはCloudflare KVの最小限の型定義です。
 * 実際のCloudflare Workersプロジェクトでは@cloudflare/workers-typesを使用します。
 */
interface KVNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

// Default to memory storage, can be swapped at runtime
// デフォルトはメモリストレージ、実行時に切り替え可能
let currentStorage: RateLimitStorage = new MemoryRateLimitStorage();

/**
 * KV ストレージへの初期化（一度だけ実行し、以後は結果を再利用する）。
 *
 * Cloudflare Workers（本番）では RATE_LIMIT_KV バインディングを解決して
 * 分散環境で共有される KV ストレージへ切り替える。バインディングが無い環境
 * （ローカル dev / 単体テスト）では解決に失敗して null が返るため、メモリ
 * 実装をそのまま使う。初期化は冪等で、初回 checkRateLimitInternal 呼び出し時
 * に一度だけ走る。
 */
let storageInitPromise: Promise<void> | null = null;

async function ensureKvRateLimitStorage(): Promise<void> {
  if (storageInitPromise) {
    return storageInitPromise;
  }
  storageInitPromise = (async () => {
    try {
      const { getKvBinding } = await import("@/lib/cloudflare-kv");
      const kv = await getKvBinding();
      if (kv) {
        // KVNamespaceLike は get/put/delete の最小契約のみ持つため、
        // 実装上必要になる 'json' 型指定付き get を持つ形へ型を寄せる。
        currentStorage = new KVRateLimitStorage(kv as unknown as KVNamespace);
      }
    } catch {
      // バインディング解決失敗時はメモリ実装のまま継続（fail-open 契約を維持）
    }
  })();
  return storageInitPromise;
}

/**
 * Set the rate limit storage backend
 * レート制限ストレージバックエンドを設定
 *
 * Call this at application startup to switch to a different storage backend.
 * アプリケーション起動時に呼び出して、別のストレージバックエンドに切り替える。
 *
 * Example for Cloudflare Workers:
 * ```typescript
 * import { setRateLimitStorage, KVRateLimitStorage } from '@/lib/rate-limit';
 *
 * export default {
 *   async fetch(request, env) {
 *     setRateLimitStorage(new KVRateLimitStorage(env.RATE_LIMIT_KV));
 *     // ... rest of your handler
 *   }
 * }
 * ```
 */
export function setRateLimitStorage(storage: RateLimitStorage): void {
  currentStorage = storage;
}

/**
 * Get the current rate limit storage
 * 現在のレート制限ストレージを取得
 */
export function getRateLimitStorage(): RateLimitStorage {
  return currentStorage;
}

/**
 * Internal rate limit check implementation
 * 内部レート制限チェック実装
 *
 * @param name - エンドポイント識別名（キーの一部として使用し、エンドポイントごとに独立したカウンタを保持する）
 *               Endpoint name used as part of the storage key to maintain independent counters per endpoint
 */
async function checkRateLimitInternal(
  name: string,
  limit: number,
  windowMs: number,
  identifier: string
): Promise<RateLimitResult> {
  // 初回呼び出し時に KV バインディングを確認し、利用可能なら KV ストレージへ
  // 切り替える（分散環境でのレート制限共有。無ければメモリ実装のまま）。
  await ensureKvRateLimitStorage();

  const now = Date.now();
  // エンドポイント名をキーに含めることで、異なるエンドポイント間でカウンタが共有されないようにする
  // Include endpoint name in key so counters are not shared across different endpoints
  const key = `ratelimit:${name}:${identifier}`;

  try {
    const existing = await currentStorage.get(key);
    const resetTime = now + windowMs;

    if (!existing || now > existing.resetTime) {
      await currentStorage.set(key, { count: 1, resetTime }, windowMs);
      return {
        success: true,
        limit,
        remaining: limit - 1,
        reset: resetTime,
      };
    }

    if (existing.count >= limit) {
      return {
        success: false,
        limit,
        remaining: 0,
        reset: existing.resetTime,
      };
    }

    existing.count++;
    await currentStorage.set(key, existing, existing.resetTime - now);
    return {
      success: true,
      limit,
      remaining: limit - existing.count,
      reset: existing.resetTime,
    };
  } catch (error) {
    // On storage errors, fail open (allow the request)
    // ストレージエラー時はフェイルオープン（リクエストを許可）
    logger.warn("Rate limit storage error, failing open:", error);
    return {
      success: true,
      limit,
      remaining: limit - 1,
      reset: now + windowMs,
    };
  }
}

/**
 * Create a rate limiter with specified limits
 * 指定された制限でレートリミッターを作成
 *
 * @param name - エンドポイント識別名（ストレージキーのプレフィックスとして使用）
 *               Endpoint name used as prefix in storage key to isolate counters per endpoint
 * @param limit - ウィンドウ内の最大リクエスト数 / Max requests within window
 * @param windowMs - レート制限ウィンドウ（ミリ秒） / Rate limit window in milliseconds
 */
function createRatelimit(name: string, limit: number, windowMs: number): RateLimiter {
  return {
    limit: async (identifier: string): Promise<RateLimitResult> => {
      return checkRateLimitInternal(name, limit, windowMs, identifier);
    },
  };
}

/**
 * Predefined rate limiters for different endpoints
 * 各エンドポイント用の事前定義されたレートリミッター
 */
export const rateLimits = {
  // グローバルAPIレート制限（ミドルウェアで全APIリクエストに適用）
  // 個別エンドポイントのレート制限よりも緩い設定で、DDoS防御として機能する
  // Global API rate limit applied to all API requests in middleware.
  // More generous than individual endpoint limits, serves as DDoS protection.
  global: createRatelimit("global", 1000, 60 * 1000),
  upload: createRatelimit("upload", 10, 60 * 1000),
  cardsPost: createRatelimit("cardsPost", 20, 60 * 1000),
  cardsGet: createRatelimit("cardsGet", 100, 60 * 1000),
  cardsId: createRatelimit("cardsId", 100, 60 * 1000),
  // Issue #554: pack rename (PATCH /api/cards/collections). A write endpoint
  // that cascades across several tables, so keep it as tight as the other
  // settings-mutation endpoint (streamerSettings) rather than the generous
  // read limits above.
  cardsPatch: createRatelimit("cardsPatch", 10, 60 * 1000),
  streamerSettings: createRatelimit("streamerSettings", 10, 60 * 1000),
  gacha: createRatelimit("gacha", 30, 60 * 1000),
  // Issue #783 fable review: /api/gacha/demo の broadcast&&streamerId 経路
  // （#783で認可チェックのみ追加済み）は、認証済みユーザーであればグローバル
  // 制限（1000回/分/IP）までデモイベント配信を叩けてしまう。
  // /api/gacha (rateLimits.gacha) と同じ水準の専用制限を課す。
  gachaDemoBroadcast: createRatelimit("gachaDemoBroadcast", 30, 60 * 1000),
  // Issue #735: /api/gacha/demo は意図的に無認証(OBSオーバーレイのデモ表示から
  // 直接呼ばれる)公開エンドポイントだが、従来レートリミットが一切無く、任意の
  // cardIdに対するカード情報取得（enumeration）に使えた。IPベースで課す
  // 全リクエスト共通の制限（gachaDemoBroadcastとは別枠。broadcast分岐は
  // 認証済みユーザー操作でIDベース、こちらは匿名IPベースのため識別子が異なる）。
  gachaDemoCard: createRatelimit("gachaDemoCard", 30, 60 * 1000),
  authLogin: createRatelimit("authLogin", 5, 60 * 1000),
  authCallback: createRatelimit("authCallback", 10, 60 * 1000),
  authLogout: createRatelimit("authLogout", 10, 60 * 1000),
  // Issue #836: 利用規約同意（一度きりの操作）。誤発火・連打対策に authLogout と同水準。
  tosAccept: createRatelimit("tosAccept", 10, 60 * 1000),
  authReauth: createRatelimit("authReauth", 3, 60 * 1000),
  // スコープ確認は読み取り専用の低リスク操作なので、authReauthより緩い制限を設定
  // check-scope is a read-only low-risk operation, so use a more generous limit than authReauth
  authCheckScope: createRatelimit("authCheckScope", 20, 60 * 1000),
  eventsub: createRatelimit("eventsub", 1000, 60 * 1000),
  twitchRewardsGet: createRatelimit("twitchRewardsGet", 50, 60 * 1000),
  twitchRewardsPost: createRatelimit("twitchRewardsPost", 20, 60 * 1000),
  eventsubSubscribePost: createRatelimit("eventsubSubscribePost", 10, 60 * 1000),
  eventsubSubscribeGet: createRatelimit("eventsubSubscribeGet", 50, 60 * 1000),
  gachaHistoryDelete: createRatelimit("gachaHistoryDelete", 30, 60 * 1000),
  // ガチャ履歴閲覧は読み取り専用のため比較的緩い制限
  // Gacha history viewing is read-only, so use a generous limit
  gachaHistoryGet: createRatelimit("gachaHistoryGet", 60, 60 * 1000),
  // ガチャ統計は集計処理があるため少し厳しめ
  // Gacha stats involves aggregation, so use a slightly stricter limit
  gachaStatsGet: createRatelimit("gachaStatsGet", 30, 60 * 1000),
  // OBS overlay polling fallback. One browser source polling every few seconds
  // should fit comfortably while still limiting accidental tight loops.
  overlayEventsGet: createRatelimit("overlayEventsGet", 120, 60 * 1000),
  debugSession: createRatelimit("debugSession", 10, 60 * 1000),
  // 投票キャンペーンは1ユーザー1回だが、DoS対策として制限（分あたり5回）
  voteCampaign: createRatelimit("voteCampaign", 5, 60 * 1000),
  // お知らせ既読はupsertで冪等だが、DoS対策として制限（分あたり20回）
  announcementRead: createRatelimit("announcementRead", 20, 60 * 1000),
  // 支援コードアクティベーション（1時間5回、Issue仕様に基づく総当り攻撃対策）
  activateCode: createRatelimit("activateCode", 5, 3600 * 1000),
  // プランダウングレード（1時間10回、activateとは独立したレート制限）
  deactivatePlan: createRatelimit("deactivatePlan", 10, 3600 * 1000),
  // 問い合わせ一覧取得（読み取り専用のため比較的緩い制限）
  supportInquiriesGet: createRatelimit("supportInquiriesGet", 60, 60 * 1000),
  // 問い合わせ投稿（スパム防止のため厳しめ: 1時間5件）
  supportInquiriesPost: createRatelimit("supportInquiriesPost", 5, 3600 * 1000),
  // 問い合わせ返信（スパム防止: 分あたり10回）
  supportInquiryReply: createRatelimit("supportInquiryReply", 10, 60 * 1000),
  // Twitch サブスク確認（分あたり5回、Twitch API負荷軽減）
  twitchCheckSubscription: createRatelimit("twitchCheckSubscription", 5, 60 * 1000),
  // Twitch サブスク手動無効化（分あたり5回）
  twitchDisableSubscription: createRatelimit("twitchDisableSubscription", 5, 60 * 1000),
  // Issue #787: メンテナンス中に退避されたEventSub通知のリプレイ。共有シークレット
  // 認証の運用エンドポイントであり、通常利用者は叩かないため他のadmin系操作と
  // 同水準（分あたり10回）に絞る。
  eventsubReplay: createRatelimit("eventsubReplay", 10, 60 * 1000),
  // Issue #788: アカウント設定のChannel Points状態確認・再判定・有効化。
  // 再判定/有効化はTwitch APIへの実疎通(probeChannelPointsCapability)を伴うため、
  // 過剰な呼び出しを防ぐ専用の低めの制限をPOST/PUT共通で使う。
  accountChannelPointsProbe: createRatelimit("accountChannelPointsProbe", 10, 60 * 1000),
  // Issue #693/#803: PlanetScale health/diagnosticsエンドポイント。
  // 共有シークレット認証の運用エンドポイントだが、eventsubReplay（書き込みを伴う
  // リプレイ実行）より低リスクな読み取り専用のため、監視ツールからの定期ポーリング
  // （数分おき等）にも耐えられるようやや緩めの水準（分あたり20回）にする。
  dbHealth: createRatelimit("dbHealth", 20, 60 * 1000),
  // Issue #540: EventSub サブスクリプション健全性監視エンドポイント。
  // dbHealth と同じ「共有シークレット認証・読み取り専用」の運用エンドポイントで、
  // 5分毎のCron Workerからの定期ポーリングに耐えられるよう同水準（分あたり20回）にする。
  eventsubHealth: createRatelimit("eventsubHealth", 20, 60 * 1000),
} as const;

/**
 * Check rate limit for a given identifier
 * 指定された識別子のレート制限をチェック
 */
export async function checkRateLimit(
  ratelimit: RateLimiter,
  identifier: string,
  limit?: number,
  windowMs?: number
): Promise<{ success: boolean; limit?: number; remaining?: number; reset?: number }> {
  try {
    const result = await ratelimit.limit(identifier);
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
    };
  } catch (error) {
    logger.error("Rate limit check failed:", error);

    if (limit && windowMs) {
      // フォールバック時はidentifierをそのままname代わりに使用（エラー時の安全策）
      // Use identifier as name fallback during error recovery
      return checkRateLimitInternal("fallback", limit, windowMs, identifier);
    }

    return {
      success: false,
      limit: limit || 0,
      remaining: 0,
      reset: Date.now() + (windowMs || 60000),
    };
  }
}

/**
 * Get client IP address from request headers
 * リクエストヘッダーからクライアントIPアドレスを取得
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return "unknown";
}

/**
 * Get rate limit identifier from request or user ID
 * リクエストまたはユーザーIDからレート制限識別子を取得
 */
export async function getRateLimitIdentifier(
  request: Request,
  twitchUserId?: string
): Promise<string> {
  if (twitchUserId) {
    return `user:${twitchUserId}`;
  }

  const ip = getClientIp(request);
  return `ip:${ip}`;
}

/**
 * Convert a rate-limit reset time (epoch ms) into a client-facing retry-after value in seconds.
 * レート制限のリセット時刻（epochミリ秒）を、クライアント向けの「待機すべき秒数」へ変換する。
 *
 * RateLimitResult.reset は `Date.now() + windowMs` の epoch ミリ秒であるため、
 * 秒単位に変換するには現在時刻（ミリ秒）との差を取ってから 1000 で割る必要がある。
 * 過去に `Math.floor(Date.now() / 1000)` を直接引く誤った実装があり、
 * 約 1.7e12 秒（≒5万年）という無意味な値を返していた（issue #786）。
 *
 * @param reset - リセット予定時刻（epoch ミリ秒）。省略時のみ fallbackMs 後の時刻とみなす
 *               （`??` のため明示的な 0 はフォールバックせず 0 秒＝即時再試行許可を意味する）
 * @param fallbackMs - reset 未指定時のフォールバック待機時間（ミリ秒）
 * @returns 待機すべき秒数（0 以上にクランプした整数）
 */
export function retryAfterSeconds(reset?: number, fallbackMs = 60000): number {
  const resetTime = reset ?? Date.now() + fallbackMs;
  // 429 返却時点で reset が過去になっているケース（KV に残った古いカウンタ等）でも負値を返さないようクランプする
  return Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
}
