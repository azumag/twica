import "server-only";

import { fetchTwitchApi } from "@/lib/twitch/app-token";

/**
 * Twitch EventSub サブスクリプション監視の共通ヘルパー (Issue #540)。
 *
 * `GET /helix/eventsub/subscriptions` のページネーション取得ロジックは既に
 * `src/app/api/twitch/eventsub/subscribe/route.ts` /
 * `src/app/api/twitch/eventsub/debug/route.ts` /
 * `src/app/api/twitch/channel-point-bootstrap/route.ts` の3箇所で個別に実装
 * されている（それぞれ user_id 絞り込みの有無・返す型が微妙に異なるため、既存分の
 * 統合は本 issue のスコープ外。YAGNI: 動いている既存コードを不要にリスクへ晒さない）。
 * ただし本 issue で新規に追加する「全サブスクリプションの健全性監視」は、
 * 既存のどの route にも属さない新規の関心事なので、これ以上コピーを増やさず
 * ここへ集約する。
 */

const TWITCH_API_URL = "https://api.twitch.tv/helix";

/** Helix EventSub サブスクリプションのレスポンス形状（監視に必要な項目のみ）。 */
export interface EventSubSubscriptionSummary {
  id: string;
  status: string;
  type: string;
  condition: {
    broadcaster_user_id?: string;
    reward_id?: string;
    to_broadcaster_user_id?: string;
  };
  transport: { method: string; callback: string };
  created_at: string;
}

/**
 * このアプリ(Twitch app)が保有する全 EventSub サブスクリプションを、
 * ページネーションしながら取得する。app access token（`fetchTwitchApi`が
 * 自動付与・401時1回だけ再発行してリトライ）を使うため、streamerごとの
 * ユーザートークンは不要。
 *
 * @throws 非2xxレスポンスの場合（呼び出し元のroute handlerがcatchして
 *   汎用エラーとして扱う想定。db-health/route.tsと同様、詳細は呼び出し元で
 *   ログにのみ残しレスポンスへは汎用メッセージを返す）。
 */
export async function listAllEventSubSubscriptions(): Promise<EventSubSubscriptionSummary[]> {
  const all: EventSubSubscriptionSummary[] = [];
  let cursor: string | undefined;

  do {
    const url = cursor
      ? `${TWITCH_API_URL}/eventsub/subscriptions?after=${cursor}`
      : `${TWITCH_API_URL}/eventsub/subscriptions`;

    const response = await fetchTwitchApi(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch EventSub subscriptions: ${response.status}`);
    }

    const data = (await response.json()) as {
      data: EventSubSubscriptionSummary[];
      pagination?: { cursor?: string };
    };
    all.push(...data.data);
    cursor = data.pagination?.cursor;
  } while (cursor);

  return all;
}

/**
 * webhook transport の EventSub サブスクリプションが「生きている」とみなせる
 * status の集合。
 *
 * - `enabled`: 正常稼働中。
 * - `webhook_callback_verification_pending`: 作成直後、Twitch側のコールバック
 *   検証が完了するまでの一過性の状態（通常は数秒〜長くて数十秒で解決する）。
 *   これを unhealthy に含めると、購読作成直後にたまたま健全性チェックの
 *   cronが走った場合に誤検知してしまう。
 *
 * 上記2つ以外の status（`webhook_callback_verification_failed` /
 * `notification_failures_exceeded` / `authorization_revoked` /
 * `moderator_removed` / `user_removed` / `chat_user_banned` /
 * `version_removed` / `beta_maintenance` 等）はいずれも Twitch 側で
 * サブスクリプションが終端状態に落ちたことを示し、放置しても自然回復しない。
 * この状態のまま気づかずにいると、該当streamerの視聴者はガチャ交換ボタンを
 * 押してもチャンネルポイントだけ消費されカードが付与されない、という無音の
 * 失敗が起き続ける（issue #540 背景の #527 参照）。
 */
const HEALTHY_OR_TRANSIENT_EVENTSUB_STATUSES = new Set([
  "enabled",
  "webhook_callback_verification_pending",
]);

/** 上記の健全/一過性 status 以外を unhealthy と判定する。 */
export function isUnhealthyEventSubStatus(status: string): boolean {
  return !HEALTHY_OR_TRANSIENT_EVENTSUB_STATUSES.has(status);
}
