import "server-only";

import { getKvBinding } from "@/lib/cloudflare-kv";
import { executeDashboardRpcPg } from "@/lib/dashboard-data";
import { reportError } from "@/lib/sentry/error-handler";
import { fetchTwitchApi } from "@/lib/twitch/app-token";

/**
 * 配信中ページ（/live）のデータ層（issue #739 / 親 #632）。
 *
 * 「オプトイン配信者のうち現在Twitchでライブ中の一覧 + 公開統計」を返す。
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
  stats: { cardCount: number; redemptionCount: number } | null;
}

/** RPC get_live_directory_streamers() の返却行（migration 側の JSONB 形状）。 */
interface LiveDirectoryRpcRow {
  streamerId: string;
  twitchUserId: string;
  twitchUsername: string;
  twitchDisplayName: string;
  twitchProfileImageUrl: string | null;
  publishStats: boolean;
  cardCount: number | null;
  redemptionCount: number | null;
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
const LIVE_DIRECTORY_TTL_SECONDS = 60;
const HELIX_STREAMS_BATCH_SIZE = 100;

/** KV なし環境（ローカル next dev）用のメモリキャッシュ。 */
let memoryCache: { entries: LiveDirectoryEntry[]; expiresAt: number } | null = null;

async function fetchStreamsForUserIds(
  userIds: string[],
): Promise<Map<string, HelixStream>> {
  const liveByUserId = new Map<string, HelixStream>();

  for (let i = 0; i < userIds.length; i += HELIX_STREAMS_BATCH_SIZE) {
    const batch = userIds.slice(i, i + HELIX_STREAMS_BATCH_SIZE);
    const params = new URLSearchParams();
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

async function fetchLiveDirectoryUncached(): Promise<LiveDirectoryEntry[]> {
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
    reportError("Live directory RPC failed", { error: rpcError });
    return [];
  }

  const streamers = Array.isArray(rpcRows)
    ? (rpcRows as LiveDirectoryRpcRow[])
    : [];
  if (streamers.length === 0) {
    // オプトイン0件: Helix を呼ばない。
    return [];
  }

  let liveByUserId: Map<string, HelixStream>;
  try {
    liveByUserId = await fetchStreamsForUserIds(
      streamers.map((s) => s.twitchUserId),
    );
  } catch (error) {
    reportError("Live directory Helix streams failed", { error });
    return [];
  }

  return streamers
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
        stats: s.publishStats
          ? { cardCount: s.cardCount ?? 0, redemptionCount: s.redemptionCount ?? 0 }
          : null,
      } satisfies LiveDirectoryEntry;
    });
}

/**
 * ライブ中のオプトイン配信者一覧を返す。KVキャッシュ(60s) → メモリ → 実取得。
 * KV get/put の例外は miss 扱いで続行し reportError で通知する（/live を
 * KV 障害で 500 にしない。キャッシュ前提が崩れたことは Sentry で気づける）。
 */
export async function getLiveDirectory(): Promise<LiveDirectoryEntry[]> {
  try {
    const kv = await getKvBinding();
    if (kv) {
      const raw = await kv.get(LIVE_DIRECTORY_KV_KEY);
      if (raw) {
        return JSON.parse(raw) as LiveDirectoryEntry[];
      }
    }
  } catch (error) {
    reportError("Live directory KV read failed", { error });
  }

  if (memoryCache && memoryCache.expiresAt > Date.now()) {
    return memoryCache.entries;
  }

  const entries = await fetchLiveDirectoryUncached();

  try {
    const kv = await getKvBinding();
    if (kv) {
      await kv.put(LIVE_DIRECTORY_KV_KEY, JSON.stringify(entries), {
        expirationTtl: LIVE_DIRECTORY_TTL_SECONDS,
      });
    }
  } catch (error) {
    reportError("Live directory KV write failed", { error });
  }

  memoryCache = {
    entries,
    expiresAt: Date.now() + LIVE_DIRECTORY_TTL_SECONDS * 1000,
  };
  return entries;
}

/** テスト専用: メモリキャッシュをリセットする。 */
export function __resetLiveDirectoryCacheForTests(): void {
  memoryCache = null;
}
