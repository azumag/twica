import "server-only";

import { getKvBinding } from "@/lib/cloudflare-kv";
import { reportError } from "@/lib/sentry/error-handler";

/**
 * Twitch app access token 共通ヘルパー（issue #739）。
 *
 * client_credentials の発行は eventsub/subscribe・eventsub/debug・
 * channel-point-bootstrap の3ルートに重複していたため、ここへ集約する。
 *
 * - KVキャッシュ: キー `twitch:app-token`、TTL = min(expires_in × 0.8, 4時間)。
 *   expires_in は約60日あるため上限を短く固定し、死んだトークンの長期残留を防ぐ。
 * - 401自己回復: Helix/EventSub 呼び出しが 401 を返したら KV キーを削除して
 *   1回だけ再発行・リトライする（TWITCH_CLIENT_SECRET ローテーション時に既存の
 *   本番経路を壊さないため。旧実装は毎回新規発行だったため自己回復不要だった）。
 *   リトライ後も 401 ならそのレスポンスを返す（無限ループしない）。
 * - リクエスト内トークン伝播: メモリキャッシュにより同一リクエスト内の複数回の
 *   API 呼び出しは同じトークンを使い、401 で再発行した場合は以降の呼び出しに
 *   新トークンが渡る。Workers isolate はリクエスト間で再利用されるため、
 *   メモリキャッシュは expiresAt で期限検証してから使う。
 * - トークンはサーバ側 KV のみに保存し、クライアントへ渡さない。
 */

const APP_TOKEN_KV_KEY = "twitch:app-token";
const APP_TOKEN_MAX_TTL_SECONDS = 4 * 60 * 60;

interface CachedAppToken {
  accessToken: string;
  expiresAt: number;
}

/** リクエスト内伝播・KVなし環境（next dev）用のメモリキャッシュ。 */
let memoryToken: CachedAppToken | null = null;

async function issueAppAccessToken(): Promise<CachedAppToken> {
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
      client_secret: process.env.TWITCH_CLIENT_SECRET!,
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to get app access token");
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    // 200 でも access_token 欠落のボディが返る異常系。不正値を KV へ4時間
    // キャッシュしない（#739 レビュー指摘）。
    throw new Error("App access token response is missing access_token");
  }
  // expires_in 欠落・不正値（0以下 / NaN）は上限TTLへフォールバックする
  // （キャッシュの有効期限が NaN になると毎回再発行されるのを防ぐ）。
  const expiresInSeconds = Number(data.expires_in);
  const ttlSeconds = Math.min(
    Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? expiresInSeconds * 0.8
      : APP_TOKEN_MAX_TTL_SECONDS,
    APP_TOKEN_MAX_TTL_SECONDS,
  );
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
}

/**
 * 現在有効な app access token を返す。優先順は メモリ → KV → 新規発行。
 * KV の読み書き失敗は発行済みトークンで継続し（旧実装の毎回発行と同じ挙動）、
 * reportError で KV 不調を通知する。
 */
export async function getTwitchAppAccessToken(options?: {
  /** キャッシュ（メモリ/KV）を読まず強制的に再発行する（401自己回復用）。 */
  forceRefresh?: boolean;
}): Promise<string> {
  if (!options?.forceRefresh) {
    if (memoryToken && memoryToken.expiresAt > Date.now()) {
      return memoryToken.accessToken;
    }

    try {
      const kv = await getKvBinding();
      if (kv) {
        const raw = await kv.get(APP_TOKEN_KV_KEY);
        if (raw) {
          const cached = JSON.parse(raw) as CachedAppToken;
          if (cached.expiresAt > Date.now()) {
            memoryToken = cached;
            return cached.accessToken;
          }
        }
      }
    } catch (error) {
      reportError(
        error instanceof Error ? error : new Error(String(error)),
        { context: "twitchAppToken:kvRead" },
      );
    }
  }

  const token = await issueAppAccessToken();
  memoryToken = token;

  try {
    const kv = await getKvBinding();
    if (kv) {
      await kv.put(APP_TOKEN_KV_KEY, JSON.stringify(token), {
        // Cloudflare KV の expirationTtl 最小値は60秒。
        expirationTtl: Math.max(60, Math.floor((token.expiresAt - Date.now()) / 1000)),
      });
    }
  } catch (error) {
    reportError(
      error instanceof Error ? error : new Error(String(error)),
      { context: "twitchAppToken:kvWrite" },
    );
  }

  return token.accessToken;
}

/** メモリと KV の両方からキャッシュ済みトークンを破棄する。 */
export async function invalidateTwitchAppToken(): Promise<void> {
  memoryToken = null;
  try {
    const kv = await getKvBinding();
    if (kv) {
      await kv.delete(APP_TOKEN_KV_KEY);
    }
  } catch (error) {
    reportError(
      error instanceof Error ? error : new Error(String(error)),
      { context: "twitchAppToken:kvDelete" },
    );
  }
}

/**
 * Helix API 呼び出し。app access token を自動付与し、401 の場合はキャッシュを
 * 破棄して 1回だけ再発行・リトライする。再試行後も 401 ならそのレスポンスを
 * 返すため、無限ループにはならない。
 */
export async function fetchTwitchApi(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const doFetch = (accessToken: string) => {
    // plain object / Headers インスタンスのどちらが渡されても Authorization と
    // Client-Id を付与できるよう、Headers へ正規化してから組み立てる。
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("Client-Id", process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!);
    return fetch(url, {
      ...init,
      headers,
    });
  };

  const response = await doFetch(await getTwitchAppAccessToken());
  if (response.status === 401) {
    await invalidateTwitchAppToken();
    // 強制再発行: KV の delete がエッジへ伝播していない場合でも、キャッシュを
    // 読み戻さず新トークンを発行してリトライする（#739 レビュー指摘）。
    return doFetch(await getTwitchAppAccessToken({ forceRefresh: true }));
  }
  return response;
}

/** テスト専用: メモリキャッシュをリセットする（analysis-admin-db-driver の
 * `__setAnalysisSqlFactoryForTests` と同じ注入フック規約）。 */
export function __resetTwitchAppTokenForTests(): void {
  memoryToken = null;
}
