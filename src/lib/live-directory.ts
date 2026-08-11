import "server-only";

import { getKvBinding } from "@/lib/cloudflare-kv";
import { executeDashboardRpcPg } from "@/lib/dashboard-data";
import { reportError } from "@/lib/sentry/error-handler";
import { fetchTwitchApi } from "@/lib/twitch/app-token";

/**
 * 配信中ページ（/live）のデータ層（issue #739 / 親 #632）。
 *
 * 「オプトイン配信者のうち現在Twitchでライブ中の一覧」と、全アクティブ
 * 配信者を母集団にした直近7日間・全期間それぞれの各指標上位100件の
 * 匿名化済みランキングを返す。
 * 方式は設計で確定済みの Helix GET /streams ポーリング + KVキャッシュ(60s)。
 * EventSub stream.online/offline は購読ライフサイクル管理が過剰なため不採用。
 *
 * キャッシュは KV 自前実装（unstable_cache / ページ revalidate は本番
 * @opennextjs/cloudflare で no-op のため使わない）。KV は RATE_LIMIT_KV
 * namespace を使う（wrangler.toml で prod/preview 両方に宣言済み。本機能が
 * この namespace の最初の本番コンシューマ）。ローカル（next dev）はプロセス内
 * メモ化へフォールバックする。
 *
 * 障害時方針: RPC/DB 障害（migration 未適用の 42883 含む）も Helix 障害も
 * throw せず空配列 + reportError（公開ページを 500 にしない。「誰も配信して
 * いない」と障害を Sentry で区別する）。オプトイン 0 件なら Helix を呼ばない。
 */

export interface LiveDirectoryEntry {
  streamerId: string;
  twitchUserId: string;
  twitchLogin: string;
  displayName: string;
  profileImageUrl: string;
  title: string;
  gameName: string;
  viewerCount: number;
  startedAt: string;
  thumbnailUrl: string;
}

export interface LiveDirectoryRankingIdentity {
  twitchLogin: string;
  displayName: string;
  profileImageUrl: string;
}

export const LIVE_DIRECTORY_RANKING_METRICS = [
  "cardCount",
  "redemptionCount",
  "totalPoints",
] as const;
export type LiveDirectoryRankingMetric =
  (typeof LIVE_DIRECTORY_RANKING_METRICS)[number];

export const LIVE_DIRECTORY_RANKING_PERIODS = ["last7Days", "allTime"] as const;
export type LiveDirectoryRankingPeriod =
  (typeof LIVE_DIRECTORY_RANKING_PERIODS)[number];

export interface LiveDirectoryRankingEntry {
  /** nullならDB境界で識別情報を除去済みの匿名行。 */
  identity: LiveDirectoryRankingIdentity | null;
  cardCount: number;
  redemptionCount: number;
  totalPoints: number;
  /** SQL側の各指標上位100件のうち、この行を表示するランキング。 */
  rankedMetrics: LiveDirectoryRankingMetric[];
}

export type LiveDirectoryRankingsByPeriod = Record<
  LiveDirectoryRankingPeriod,
  LiveDirectoryRankingEntry[]
>;

/** RPC get_live_directory_streamers() の返却行（migration 側の JSONB 形状）。 */
interface LiveDirectoryRpcRow {
  streamerId: string;
  twitchUserId: string;
  twitchDisplayName: string;
  twitchProfileImageUrl: string | null;
}

/** Helix GET /streams の1行（必要なフィールドのみ）。 */
interface HelixStream {
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  game_name: string;
  viewer_count: number;
  started_at: string;
  thumbnail_url: string;
}

const LIVE_DIRECTORY_KV_KEY = "live-directory:v1";
const LIVE_DIRECTORY_RANKINGS_KV_KEY = "live-directory:rankings:v3";
const LIVE_DIRECTORY_TTL_SECONDS = 60;
const HELIX_STREAMS_BATCH_SIZE = 100;

/** KV なし環境（ローカル next dev）用のメモリキャッシュ。 */
let memoryCache: { entries: LiveDirectoryEntry[]; expiresAt: number } | null = null;
let rankingsMemoryCache: {
  entries: LiveDirectoryRankingsByPeriod;
  expiresAt: number;
} | null = null;

async function fetchStreamsForUserIds(
  userIds: string[],
): Promise<Map<string, HelixStream>> {
  const liveByUserId = new Map<string, HelixStream>();

  for (let i = 0; i < userIds.length; i += HELIX_STREAMS_BATCH_SIZE) {
    const batch = userIds.slice(i, i + HELIX_STREAMS_BATCH_SIZE);
    // Get Streams の first デフォルトは20件のため、明示的に first=100 を付与する。
    // 1 user_id につきライブは高々1本で user_id は最大100件のため、first=100 の
    // 初回ページで全件が揃う。cursor 追従は「結果を返し切った後も cursor を返す」
    // という Twitch の挙動で無限ループの余地があるため行わない（#739 レビュー必須）。
    const params = new URLSearchParams();
    params.set("first", String(HELIX_STREAMS_BATCH_SIZE));
    for (const userId of batch) {
      params.append("user_id", userId);
    }

    const response = await fetchTwitchApi(
      `https://api.twitch.tv/helix/streams?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(`Helix GET /streams failed: status=${response.status}`);
    }
    const data = (await response.json()) as { data: HelixStream[] };
    for (const stream of data.data ?? []) {
      liveByUserId.set(stream.user_id, stream);
    }
  }

  return liveByUserId;
}

interface LiveDirectoryFetchResult {
  entries: LiveDirectoryEntry[];
  /** false のときは障害（RPC/Helix）による空配列。キャッシュへ書き込まない。 */
  ok: boolean;
}

async function fetchLiveDirectoryUncached(): Promise<LiveDirectoryFetchResult> {
  const { data: rpcRows, error: rpcError } = await executeDashboardRpcPg(
    "get_live_directory_streamers(pg)",
    async (sql) => {
      const rows = await sql<Array<{ result: unknown }>>`
        select get_live_directory_streamers() as result
      `;
      return rows[0]?.result;
    },
  );

  if (rpcError) {
    await reportError(
      new Error(`Live directory RPC failed: ${rpcError.message}`),
      { context: "liveDirectory:rpc" },
    );
    return { entries: [], ok: false };
  }

  const streamers = Array.isArray(rpcRows)
    ? (rpcRows as LiveDirectoryRpcRow[])
    : [];
  if (streamers.length === 0) {
    // オプトイン0件は正常な空状態のためキャッシュしてよい。
    return { entries: [], ok: true };
  }

  let liveByUserId: Map<string, HelixStream>;
  try {
    liveByUserId = await fetchStreamsForUserIds(
      streamers.map((s) => s.twitchUserId),
    );
  } catch (error) {
    await reportError(
      error instanceof Error ? error : new Error(String(error)),
      { context: "liveDirectory:helix" },
    );
    return { entries: [], ok: false };
  }

  return {
    entries: streamers
      .filter((s) => liveByUserId.has(s.twitchUserId))
      .map((s) => {
        const stream = liveByUserId.get(s.twitchUserId)!;
        return {
          streamerId: s.streamerId,
          twitchUserId: s.twitchUserId,
          twitchLogin: stream.user_login,
          displayName: s.twitchDisplayName,
          profileImageUrl: s.twitchProfileImageUrl ?? "",
          title: stream.title,
          gameName: stream.game_name,
          viewerCount: stream.viewer_count,
          startedAt: stream.started_at,
          thumbnailUrl: stream.thumbnail_url
            .replace("{width}", "320")
            .replace("{height}", "180"),
        } satisfies LiveDirectoryEntry;
      }),
    ok: true,
  };
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/**
 * KVのライブ一覧を公開型へホワイトリスト変換する。
 *
 * 同じKV keyには旧リリースが書いたstats等がTTL中だけ残り得る。TypeScriptの
 * type assertionは実行時の余分なfieldを削除しないため、RSC payloadへ旧fieldを
 * 再送しないよう各fieldを明示的に再構築する。識別に必要な3値が壊れた行だけは
 * リンク先を安全に作れないので破棄し、それ以外の表示値は空文字/0へ正規化する。
 */
function normalizeLiveDirectoryEntries(value: unknown): LiveDirectoryEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.streamerId !== "string" ||
      typeof row.twitchUserId !== "string" ||
      typeof row.twitchLogin !== "string"
    ) {
      return [];
    }

    return [{
      streamerId: row.streamerId,
      twitchUserId: row.twitchUserId,
      twitchLogin: row.twitchLogin,
      displayName: typeof row.displayName === "string" ? row.displayName : "",
      profileImageUrl:
        typeof row.profileImageUrl === "string" ? row.profileImageUrl : "",
      title: typeof row.title === "string" ? row.title : "",
      gameName: typeof row.gameName === "string" ? row.gameName : "",
      viewerCount: normalizeNonNegativeInteger(row.viewerCount),
      startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
      thumbnailUrl: typeof row.thumbnailUrl === "string" ? row.thumbnailUrl : "",
    }];
  });
}

/**
 * RPCの戻り値を公開型へホワイトリスト変換する。
 *
 * SQLでもpublish_stats=false時にidentityをNULL化しているが、ここでも許可した
 * 3フィールドだけを再構築する。将来RPCへ内部列が追加されても、RSC payloadへ
 * 意図せず流出しないようプライバシー境界を二重化する。
 */
function normalizeRankingEntries(value: unknown): LiveDirectoryRankingEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    // JSON配列内の壊れたprimitiveを匿名0件として残すと、実在しないランキング行を
    // 作ってしまう。ライブ一覧の正規化と同じく、objectでない行は破棄する。
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const rawIdentity = row.identity;
    let identity: LiveDirectoryRankingIdentity | null = null;

    if (rawIdentity && typeof rawIdentity === "object") {
      const candidate = rawIdentity as Record<string, unknown>;
      if (
        typeof candidate.twitchLogin === "string" &&
        typeof candidate.displayName === "string"
      ) {
        identity = {
          twitchLogin: candidate.twitchLogin,
          displayName: candidate.displayName,
          profileImageUrl:
            typeof candidate.profileImageUrl === "string"
              ? candidate.profileImageUrl
              : "",
        };
      }
    }

    // SQLは各指標の正値上位100件だけを指定する。キャッシュ境界でも列挙した値
    // だけを許可し、未知のmetricで任意プロパティ参照が起きないようにする。
    const counters = {
      cardCount: normalizeNonNegativeInteger(row.cardCount),
      redemptionCount: normalizeNonNegativeInteger(row.redemptionCount),
      totalPoints: normalizeNonNegativeInteger(row.totalPoints),
    };
    const rawRankedMetrics = Array.isArray(row.rankedMetrics)
      ? row.rankedMetrics
      : [];
    const rankedMetrics = LIVE_DIRECTORY_RANKING_METRICS.filter(
      (metric) => rawRankedMetrics.includes(metric) && counters[metric] > 0,
    );
    if (rankedMetrics.length === 0) return [];

    return [{
      identity,
      ...counters,
      rankedMetrics,
    }];
  });
}

/**
 * 期間別RPC/KV payloadを、列挙済みの2期間と公開ランキング行だけへ絞り込む。
 *
 * Recordへの型assertionだけでは、将来RPCへ追加された期間名や内部fieldがRSCへ
 * そのまま流れる。期間キーも明示的に再構築し、欠損・破損した期間は空配列として
 * 公開ページ自体を維持する。
 */
function normalizeRankingsByPeriod(value: unknown): LiveDirectoryRankingsByPeriod {
  const source = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};

  return {
    last7Days: normalizeRankingEntries(source.last7Days),
    allTime: normalizeRankingEntries(source.allTime),
  };
}

interface LiveDirectoryRankingsFetchResult {
  entries: LiveDirectoryRankingsByPeriod;
  /** falseならRPC障害。障害による空配列はキャッシュしない。 */
  ok: boolean;
}

async function fetchLiveDirectoryRankingsUncached(): Promise<LiveDirectoryRankingsFetchResult> {
  const { data: rpcRows, error: rpcError } = await executeDashboardRpcPg(
    "get_live_directory_rankings_by_period(pg)",
    async (sql) => {
      const rows = await sql<Array<{ result: unknown }>>`
        select get_live_directory_rankings_by_period() as result
      `;
      return rows[0]?.result;
    },
  );

  if (rpcError) {
    await reportError(
      new Error(`Live directory rankings RPC failed: ${rpcError.message}`),
      { context: "liveDirectory:rankingsRpc" },
    );
    return {
      entries: { last7Days: [], allTime: [] },
      ok: false,
    };
  }

  return { entries: normalizeRankingsByPeriod(rpcRows), ok: true };
}

/**
 * 直近7日間・全期間それぞれについて、各指標の正値上位100件に入る配信者の
 * 匿名化済みランキング集計を返す。
 * ライブ一覧とはDB同意・障害境界が異なるため別キャッシュにし、新RPCが未反映の
 * デプロイ窓でも既存のライブ一覧キャッシュを巻き込んで無効化しない。
 */
export async function getLiveDirectoryRankings(): Promise<LiveDirectoryRankingsByPeriod> {
  try {
    const kv = await getKvBinding();
    if (kv) {
      const raw = await kv.get(LIVE_DIRECTORY_RANKINGS_KV_KEY);
      if (raw) {
        return normalizeRankingsByPeriod(JSON.parse(raw));
      }
    }
  } catch (error) {
    await reportError(
      error instanceof Error ? error : new Error(String(error)),
      { context: "liveDirectory:rankingsKvRead" },
    );
  }

  if (rankingsMemoryCache && rankingsMemoryCache.expiresAt > Date.now()) {
    return rankingsMemoryCache.entries;
  }

  const { entries, ok } = await fetchLiveDirectoryRankingsUncached();
  if (ok) {
    try {
      const kv = await getKvBinding();
      if (kv) {
        await kv.put(LIVE_DIRECTORY_RANKINGS_KV_KEY, JSON.stringify(entries), {
          expirationTtl: LIVE_DIRECTORY_TTL_SECONDS,
        });
      }
    } catch (error) {
      await reportError(
        error instanceof Error ? error : new Error(String(error)),
        { context: "liveDirectory:rankingsKvWrite" },
      );
    }
    rankingsMemoryCache = {
      entries,
      expiresAt: Date.now() + LIVE_DIRECTORY_TTL_SECONDS * 1000,
    };
  }

  return entries;
}

/**
 * ライブ中のオプトイン配信者一覧を返す。KVキャッシュ(60s) → メモリ → 実取得。
 * KV get/put の例外は miss 扱いで続行し reportError で通知する（/live を
 * KV 障害で 500 にしない。キャッシュ前提が崩れたことは Sentry で気づける）。
 * RPC/Helix 障害による空配列はキャッシュへ書き込まない（瞬断が最大60秒の
 * 「誰も配信していない」表示に化けるのを防ぐ）。
 */
export async function getLiveDirectory(): Promise<LiveDirectoryEntry[]> {
  try {
    const kv = await getKvBinding();
    if (kv) {
      const raw = await kv.get(LIVE_DIRECTORY_KV_KEY);
      if (raw) {
        return normalizeLiveDirectoryEntries(JSON.parse(raw));
      }
    }
  } catch (error) {
    await reportError(
      error instanceof Error ? error : new Error(String(error)),
      { context: "liveDirectory:kvRead" },
    );
  }

  if (memoryCache && memoryCache.expiresAt > Date.now()) {
    return memoryCache.entries;
  }

  const { entries, ok } = await fetchLiveDirectoryUncached();

  if (ok) {
    try {
      const kv = await getKvBinding();
      if (kv) {
        await kv.put(LIVE_DIRECTORY_KV_KEY, JSON.stringify(entries), {
          expirationTtl: LIVE_DIRECTORY_TTL_SECONDS,
        });
      }
    } catch (error) {
      await reportError(
        error instanceof Error ? error : new Error(String(error)),
        { context: "liveDirectory:kvWrite" },
      );
    }
    memoryCache = {
      entries,
      expiresAt: Date.now() + LIVE_DIRECTORY_TTL_SECONDS * 1000,
    };
  }

  return entries;
}

/** テスト専用: メモリキャッシュをリセットする。 */
export function __resetLiveDirectoryCacheForTests(): void {
  memoryCache = null;
  rankingsMemoryCache = null;
}
