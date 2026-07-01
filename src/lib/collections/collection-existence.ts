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

export type CollectionExistenceResult =
  | "exists" // at least one active card belongs to this pack
  | "absent" // no active card belongs to this pack → would cause empty draws
  | "schema-not-ready"; // collection_name column not deployed yet (deploy window)

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
  const { count, error } = await supabaseAdmin
    .from("cards")
    .select("id", { count: "exact", head: true })
    .eq("streamer_id", streamerId)
    .eq("collection_name", collectionName)
    .eq("is_active", true);

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
