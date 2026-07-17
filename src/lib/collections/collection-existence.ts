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
import { getErrorChain } from "@/lib/db/errors";
// -----------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。checkCollectionHasActiveCards は
// 読み取り専用（COUNT のみ）のため isPgReadEnabled() で分岐する。既存 supabase-js
// 実装は 1 文字も変えず、フラグ未設定時は完全に従来どおり動く。
// -----------------------------------------------------------------------------
import { and, count, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable } from "@/lib/db/schema";

/**
 * Shared per-layer matcher for the six "column/RPC not deployed yet" detectors
 * below. cause チェーン対応 (2026-07 本番障害の恒久対応):
 *
 * These detectors are used on BOTH the PostgREST and pg (Drizzle) driver
 * paths — e.g. `checkCollectionHasActiveCardsPg` below and
 * `getStreamerForSettingsUpdate` (streamer/settings/route.ts) pass a raw
 * pg-driver-thrown error straight into `isMissingCollectionNameColumn` /
 * `isMissingCardPackNamesColumnError` etc. Drizzle wraps the postgres.js
 * PostgresError in `DrizzleQueryError { query, params, cause }`, so the real
 * SQLSTATE and "column ... does not exist" text live on `.cause`, not on the
 * top-level error. Checking only the top level silently disabled every
 * deploy-window fallback in this file on the pg path (root cause of the
 * getActiveCardsForStreamer (pg) empty-collection incident, same class of bug
 * fixed in cards-safe-columns.ts / card-number-errors.ts). getErrorChain walks
 * top-level → cause → cause.cause (bounded depth) so both raw
 * postgrest/postgres.js errors (1-element chain, unchanged behavior) and
 * Drizzle-wrapped errors are detected.
 *
 * Per-layer isolation (Fable厳格レビュー指摘・中4): an earlier version of this
 * helper concatenated every layer's message/details/hint into one string
 * before matching. That over-matches: DrizzleQueryError.message is literally
 * the executed SQL text, which lists every selected/inserted column, so a
 * concatenated match can find e.g. "collection_name" in the wrapper's SQL
 * text even when the real `cause` is an unrelated 42703 for a *different*
 * column (or an unrelated error entirely). `matcher` therefore receives ONE
 * layer's own signals at a time — text.includes(...) can only fire if that
 * SAME layer's own message/details/hint contains the substring, not a
 * different layer's. Returns true as soon as any single layer satisfies the
 * full matcher on its own.
 *
 * Parameter is `unknown` (not a narrow `{ message?, code?, ... }` shape):
 * callers pass both raw PostgrestError objects and raw pg/Drizzle-thrown
 * errors, whose shapes only overlap on `.cause`/`.query` vs `.message`/
 * `.code` — a shared structural type would reject one side or the other (and
 * TypeScript flags object literals with an all-optional target type as an
 * error when they share no properties, which real Drizzle-wrapped errors
 * don't). getErrorChain + the per-layer cast are what actually keep this safe
 * against arbitrary `unknown` input.
 */
function matchesAnyErrorLayer(
  error: unknown,
  matcher: (layer: { text: string; code: unknown }) => boolean
): boolean {
  return getErrorChain(error).some((layer) => {
    if (typeof layer !== "object" || layer === null) return false;
    const err = layer as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const text = [err.message, err.details, err.hint].map((value) => String(value ?? "")).join(" ");
    return matcher({ text, code: err.code });
  });
}

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
export function isMissingCollectionNameColumn(error: unknown): boolean {
  if (!error) return false;

  // Intentionally NOT matching a bare "column" substring: a future NOT NULL
  // constraint violation (code 23502: "null value in column 'collection_name'
  // ... violates not-null constraint") would otherwise be misread as a
  // missing-column error and silently swallow a real write failure. PostgreSQL's
  // 42703 always says "does not exist" and PostgREST's PGRST204 says
  // "schema cache", so these three signals cover both access paths without that
  // false positive.
  return matchesAnyErrorLayer(error, ({ text, code }) =>
    text.includes("collection_name") &&
    (code === "PGRST204" ||
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
export function isMissingCardPackNamesColumnError(error: unknown): boolean {
  if (!error) return false;

  return matchesAnyErrorLayer(error, ({ text, code }) =>
    text.includes("card_pack_names") &&
    (code === "PGRST204" ||
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
export function isMissingDefaultCardPackNameColumnError(error: unknown): boolean {
  if (!error) return false;

  return matchesAnyErrorLayer(error, ({ text, code }) =>
    text.includes("default_card_pack_name") &&
    (code === "PGRST204" ||
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
export function isMissingRenameCardPackFunctionError(error: unknown): boolean {
  if (!error) return false;

  return matchesAnyErrorLayer(
    error,
    ({ text, code }) => text.includes("rename_card_pack") && code === "42883"
  );
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
export function isMissingRarityWeightsScopeColumnError(error: unknown): boolean {
  if (!error) return false;

  return matchesAnyErrorLayer(error, ({ text, code }) =>
    text.includes("rarity_weights_scope") &&
    (code === "PGRST204" ||
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
export function isMissingPackRarityWeightsColumnError(error: unknown): boolean {
  if (!error) return false;

  return matchesAnyErrorLayer(error, ({ text, code }) =>
    text.includes("pack_rarity_weights") &&
    (code === "PGRST204" ||
      text.includes("does not exist") ||
      text.includes("schema cache"))
  );
}

export type CollectionExistenceResult =
  | "exists" // at least one active card belongs to this pack
  | "absent" // no active card belongs to this pack → would cause empty draws
  | "schema-not-ready"; // collection_name column not deployed yet (deploy window)

/**
 * checkCollectionHasActiveCards の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - `{ count: "exact", head: true }` は drizzle-orm の count() ヘルパー
 *   （`sql`count(*)`.mapWith(Number)` 相当）で件数のみ取得する形に置き換える。
 * - DEFAULT_PACK_SENTINEL の場合は isNull(collection_name)、それ以外は
 *   eq(collection_name, collectionName)（postgrest 経路と同じ分岐）。
 * - isMissingCollectionNameColumn は message テキスト（"does not exist" /
 *   "schema cache"）ベースの汎用判定のため、pg（postgres.js）が throw する
 *   PostgresError（code: '42703', message に "does not exist" を含む）も
 *   そのまま判定できる。pg 専用の判定関数は不要（既存ヘルパーをそのまま再利用）。
 * - 想定外のエラーは throw して呼び出し元で 500 にする（既存と同じ）。
 */
async function checkCollectionHasActiveCardsPg(
  streamerId: string,
  collectionName: string
): Promise<CollectionExistenceResult> {
  const collectionCondition =
    collectionName === DEFAULT_PACK_SENTINEL
      ? isNull(cardsTable.collection_name)
      : eq(cardsTable.collection_name, collectionName);

  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ count: count() })
          .from(cardsTable)
          .where(
            and(
              eq(cardsTable.streamer_id, streamerId),
              eq(cardsTable.is_active, true),
              collectionCondition
            )
          );
      },
      "checkCollectionHasActiveCards",
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );

    return (rows[0]?.count ?? 0) > 0 ? "exists" : "absent";
  } catch (error) {
    if (isMissingCollectionNameColumn(error as { message?: string; code?: string } | null | undefined)) {
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
  // #663: 読み取り専用の関数のため isPgReadEnabled() で分岐。
  // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
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
