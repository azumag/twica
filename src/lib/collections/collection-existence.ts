// Issue #393: server-side existence check for card packs ("collections").
//
// Server-only: reads the `cards` table. It receives the Supabase admin client as
// an argument instead of importing it, so this module never pulls the admin
// client into a client bundle. The pure name validation lives separately in
// `@/lib/validation/collection-name`.
//
// 課題 #393: カードパック存在検証(サーバ専用)。admin client は引数で受け取り、
// 本モジュール自身は import しない(client bundle 混入防止)。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
// Issue #663: 読み取り専用（COUNT のみ）の pg 直結経路。
// getDb() は withDbRetry の queryFn 内で呼ぶ規約（src/lib/db/retry.ts 参照）。
// count は下の postgrest 経路の分割代入 `const { count, error }` と名前が
// 紛らわしいため countRows という別名で import する
// （src/app/api/twitch/eventsub/route.ts の fetchActiveCardCountPg と同じ理由）。
import { and, count as countRows, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { isPgMissingColumnError } from "@/lib/db/errors";
import { cards as cardsTable } from "@/lib/db/schema";

/**
 * Detect the "collection_name column is not deployed yet" schema error.
 *
 * Gate on the column name (`collection_name`, which also covers
 * `channel_point_collection_name`) to avoid false positives — notably the
 * raid-option schema errors which mention `draw_count` / `is_raid_limited` and
 * would otherwise collide on a bare PGRST204 code.
 *
 * Once gated, accept BOTH error shapes because the two access paths fail
 * differently:
 *  - WRITE (insert/update payload column): PostgREST returns code `PGRST204`
 *    ("Could not find the '...' column in the schema cache").
 *  - READ (select / order / filter on a missing column): PostgreSQL returns
 *    `42703` ("column ... does not exist"), NOT PGRST204.
 * Checking only PGRST204 would silently fail to fall back on read paths during
 * the deploy window. This mirrors `isMissingCardNumberColumnError`, which is
 * already used on a read (order-by) path the same way.
 *
 * 書き込み(payload列欠落)は PGRST204、読み取り(SELECT/ORDER/フィルタの列欠落)は
 * 42703 を返すため、両方を受ける。collection_name 名でゲートして誤検知を防ぐ。
 */
export function isMissingCollectionNameColumn(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined
): boolean {
  if (!error) return false;
  const text = [error.message, error.details, error.hint]
    .map((value) => String(value ?? ""))
    .join(" ");

  // Intentionally NOT matching a bare "column" substring: a future NOT NULL
  // constraint violation (code 23502: "null value in column 'collection_name'
  // ... violates not-null constraint") would otherwise be misread as a
  // missing-column error and silently swallow a real write failure. PostgreSQL's
  // 42703 always says "does not exist" and PostgREST's PGRST204 says
  // "schema cache", so these three signals cover both access paths without that
  // false positive.
  return (
    text.includes("collection_name") &&
    (error.code === "PGRST204" ||
      text.includes("does not exist") ||
      text.includes("schema cache"))
  );
}

/**
 * Detect the "card_pack_names column is not deployed yet" schema error.
 *
 * Separate function (not folded into `isMissingCollectionNameColumn`) because
 * that helper gates specifically on the substring "collection_name", which
 * `card_pack_names` does not contain — mirrors this codebase's existing
 * one-helper-per-column convention (see `isMissingCardNumberColumnError`).
 *
 * Same dual error-shape handling as `isMissingCollectionNameColumn`: PGRST204
 * on write paths, 42703 ("does not exist") / "schema cache" on read paths.
 *
 * `card_pack_names`(パック事前登録一覧, #393再設計)列の未デプロイ検知。
 * `collection_name` 文言でゲートする既存関数とは別に用意する(列ごとに専用
 * 関数を持つ既存の慣習(`isMissingCardNumberColumnError`)に合わせる)。
 */
export function isMissingCardPackNamesColumnError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined
): boolean {
  if (!error) return false;
  const text = [error.message, error.details, error.hint]
    .map((value) => String(value ?? ""))
    .join(" ");

  return (
    text.includes("card_pack_names") &&
    (error.code === "PGRST204" ||
      text.includes("does not exist") ||
      text.includes("schema cache"))
  );
}

/**
 * Detect the "default_card_pack_name column is not deployed yet" schema error.
 *
 * Separate function for the same reason as `isMissingCardPackNamesColumnError`:
 * this column's name doesn't contain "collection_name", so the existing
 * gate would never match it (one-helper-per-column convention).
 *
 * Issue #554: `streamers.default_card_pack_name` (display-name override for
 * the default/unclassified pseudo-pack) ships in the same PR as its API
 * consumers, so a rolling deploy can briefly have the app code live before
 * the migration has run — this lets the settings route skip persisting the
 * field during that window instead of 500ing.
 */
export function isMissingDefaultCardPackNameColumnError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined
): boolean {
  if (!error) return false;
  const text = [error.message, error.details, error.hint]
    .map((value) => String(value ?? ""))
    .join(" ");

  return (
    text.includes("default_card_pack_name") &&
    (error.code === "PGRST204" ||
      text.includes("does not exist") ||
      text.includes("schema cache"))
  );
}

/**
 * Detect the "rename_card_pack RPC is not deployed yet" error.
 *
 * Issue #554: `public.rename_card_pack` ships in migration 00063, in the same
 * PR as the PATCH /api/cards/collections route that calls it via
 * `supabaseAdmin.rpc(...)`. During a rolling deploy the app code can go live
 * before the migration finishes, in which case PostgREST/Postgres reports
 * `42883` (`undefined_function`) — NOT one of the PGRST204/42703 shapes used
 * by the missing-COLUMN detectors above, since this is a missing FUNCTION.
 * The route uses this to return a "feature not ready yet" response instead of
 * a raw 500.
 */
export function isMissingRenameCardPackFunctionError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined
): boolean {
  if (!error) return false;
  const text = [error.message, error.details, error.hint]
    .map((value) => String(value ?? ""))
    .join(" ");

  return text.includes("rename_card_pack") && error.code === "42883";
}

/**
 * Detect the "rarity_weights_scope column is not deployed yet" schema error.
 *
 * Separate function for the same reason as `isMissingCardPackNamesColumnError`
 * / `isMissingDefaultCardPackNameColumnError`: this column's name doesn't
 * contain "collection_name", so the existing gate would never match it
 * (one-helper-per-column convention).
 *
 * Issue #578 (#576 Phase 1): `streamers.rarity_weights_scope` ships in
 * migration 00065, in the same PR as the settings route that writes it — a
 * rolling deploy can briefly have the app code live before the migration has
 * run, so the route uses this to skip persisting the field during that
 * window instead of 500ing.
 */
export function isMissingRarityWeightsScopeColumnError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined
): boolean {
  if (!error) return false;
  const text = [error.message, error.details, error.hint]
    .map((value) => String(value ?? ""))
    .join(" ");

  return (
    text.includes("rarity_weights_scope") &&
    (error.code === "PGRST204" ||
      text.includes("does not exist") ||
      text.includes("schema cache"))
  );
}

/**
 * Detect the "pack_rarity_weights column is not deployed yet" schema error.
 *
 * Same rationale/shape as `isMissingRarityWeightsScopeColumnError` above —
 * `streamers.pack_rarity_weights` ships in the same migration (00065).
 * Kept as a distinct helper (rather than folded into the scope check) so
 * each column can independently fall back during the deploy window, mirroring
 * how `card_pack_names` and `default_card_pack_name` are detected separately
 * even though they shipped close together.
 */
export function isMissingPackRarityWeightsColumnError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined
): boolean {
  if (!error) return false;
  const text = [error.message, error.details, error.hint]
    .map((value) => String(value ?? ""))
    .join(" ");

  return (
    text.includes("pack_rarity_weights") &&
    (error.code === "PGRST204" ||
      text.includes("does not exist") ||
      text.includes("schema cache"))
  );
}

export type CollectionExistenceResult =
  | "exists" // at least one active card belongs to this pack
  | "absent" // no active card belongs to this pack → would cause empty draws
  | "schema-not-ready"; // collection_name column not deployed yet (deploy window)

/**
 * checkCollectionHasActiveCards の pg 直結（Drizzle）実装 (#663)
 *
 * PostgREST 実装との対応:
 * - `.select("id", { count: "exact", head: true })`（行データを取らず件数のみ
 *   問い合わせる COUNT クエリ）は Drizzle の count() 集計（SELECT count(*)）が
 *   等価（src/app/api/twitch/eventsub/route.ts の fetchActiveCardCountPg と
 *   同じ対応）。
 * - DEFAULT_PACK_SENTINEL のときは isNull(collection_name)、それ以外は
 *   eq(collection_name, collectionName) で分岐（既存の .is()/.eq() 分岐と同じ）。
 * - isMissingCollectionNameColumn（PGRST204 / 42703 の両形状を text で判定）に
 *   対応する pg 版は isPgMissingColumnError（SQLSTATE 42703）。このクエリが
 *   参照する列のうち streamer_id / is_active は初版から存在し、collection_name
 *   のみ後発（00061）のため、42703 が起きるとすれば collection_name 起因と
 *   考えて良い（getCollectionCompletionsPg 等と同じ判断根拠）。
 * - 上記以外のエラーは既存実装と同じく呼び出し元へ throw する（「空パックかも
 *   しれないのに保存成功」を防ぐフェイルクローズを維持する）。
 *
 * 読み取り専用（COUNT のみ）のため冪等（idempotent: true）としてリトライを
 * opt-in する。
 */
async function checkCollectionHasActiveCardsPg(
  streamerId: string,
  collectionName: string
): Promise<CollectionExistenceResult> {
  try {
    const activeCount = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        const packCondition =
          collectionName === DEFAULT_PACK_SENTINEL
            ? isNull(cardsTable.collection_name)
            : eq(cardsTable.collection_name, collectionName);
        const [row] = await db
          .select({ count: countRows() })
          .from(cardsTable)
          .where(
            and(
              eq(cardsTable.streamer_id, streamerId),
              eq(cardsTable.is_active, true),
              packCondition
            )
          );
        // count(*) は必ず 1 行返るが、消費側の `count ?? 0` と同じ安全側の既定値
        return row?.count ?? 0;
      },
      "checkCollectionHasActiveCards",
      { idempotent: true }
    );

    return activeCount > 0 ? "exists" : "absent";
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      return "schema-not-ready";
    }
    throw error;
  }
}

/**
 * Check whether a streamer has at least one ACTIVE card in the given pack.
 *
 * Gacha only draws from `is_active = true` cards, so a pack made of only inactive
 * cards must be rejected at save time — otherwise live redemptions fail with
 * "No cards available". When the column is not yet deployed we return
 * `schema-not-ready` so callers can skip validation during the deploy window.
 *
 * ガチャは is_active=true のみを抽選するため、非アクティブのみのパックは保存時に
 * 弾く(本番引換で空抽選になるのを防ぐ)。列未デプロイ時は schema-not-ready を返す。
 */
export async function checkCollectionHasActiveCards(
  supabaseAdmin: SupabaseClient<Database>,
  streamerId: string,
  collectionName: string
): Promise<CollectionExistenceResult> {
  // Issue #663: 読み取り専用（COUNT のみ）のため isPgReadEnabled() で分岐。
  // フラグ未設定時（既定 'postgrest'）は以下の既存実装が従来どおり動く。
  if (isPgReadEnabled()) {
    return checkCollectionHasActiveCardsPg(streamerId, collectionName);
  }

  let query = supabaseAdmin
    .from("cards")
    .select("id", { count: "exact", head: true })
    .eq("streamer_id", streamerId)
    .eq("is_active", true);

  // Issue #555: DEFAULT_PACK_SENTINEL asks about the DEFAULT pack (cards left
  // unclassified, i.e. collection_name IS NULL) — the inverse of the normal
  // named-pack lookup, which needs `.eq(...)` against a literal string.
  // `.eq('collection_name', DEFAULT_PACK_SENTINEL)` would never match anything
  // (no card actually has that literal string as its collection_name), so this
  // must branch to `.is(...)`. Mirrors how executeGacha resolves the same
  // sentinel when drawing cards (see gacha.ts).
  query = collectionName === DEFAULT_PACK_SENTINEL
    ? query.is("collection_name", null)
    : query.eq("collection_name", collectionName);

  const { count, error } = await query;

  if (error) {
    if (isMissingCollectionNameColumn(error)) {
      return "schema-not-ready";
    }
    // Unexpected DB error: surface it so the route returns 500 rather than
    // silently allowing a possibly-empty pack to be saved.
    throw error;
  }

  return (count ?? 0) > 0 ? "exists" : "absent";
}
