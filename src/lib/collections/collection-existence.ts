// Issue #393: server-side existence check for card packs ("collections").
// DB access is fixed to the PlanetScale PostgreSQL/Drizzle path. Pure name
// validation lives separately in `@/lib/validation/collection-name`.
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import { getErrorChain, isPgMissingNamedColumnError } from "@/lib/db/errors";
import { and, count, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable } from "@/lib/db/schema";

/**
 * RPC 欠落判定用の階層 matcher。列欠落は SQLSTATE と列名を同じエラー階層で
 * 検証する共通 helper (`isPgMissingNamedColumnError`) を使う。関数欠落だけは
 * 42883 と関数名の組み合わせをここで検証する。
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
 * `collection_name`（`channel_point_collection_name` も部分一致）を伴う
 * SQLSTATE 42703 だけを列未配備として扱う。列名で絞ることで raid option の
 * `draw_count` / `is_raid_limited` 欠落を誤認しない。
 *
 * #954: 以前は cards.collection_name（Issue #393 由来）のデプロイ窓フォールバック
 * として cards routes / checkCollectionHasActiveCardsPg からも使われていたが、
 * #834 (PR #953) と同じ手順で PlanetScale 本番・preview の information_schema
 * 実測により cards.collection_name の実在を確認したため、cards 側の利用は撤去した
 * （Issue #954）。このヘルパー自体は streamers.channel_point_collection_name
 * （streamer settings の SELECT/UPDATE、別 migration 由来の別列）のデプロイ窓
 * フォールバック判定に現役で使われているため温存する（同名部分一致の判定が
 * channel_point_collection_name をも網羅する設計）。この列は #954 の実測対象外
 * であり、撤去する場合は別 issue で同様の実測を行うこと。
 */
export function isMissingCollectionNameColumn(error: unknown): boolean {
  if (!error) return false;

  return isPgMissingNamedColumnError(error, ["collection_name"]);
}

/**
 * Detect the "card_pack_names column is not deployed yet" schema error.
 *
 * Separate function (not folded into `isMissingCollectionNameColumn`) because
 * that helper gates specifically on the substring "collection_name", which
 * `card_pack_names` does not contain — mirrors this codebase's existing
 * one-helper-per-column convention (see `isMissingCardNumberColumnError`).
 *
 * `card_pack_names`(パック事前登録一覧, #393再設計)列の未デプロイ検知。
 * `collection_name` 文言でゲートする既存関数とは別に用意する(列ごとに専用
 * 関数を持つ既存の慣習(`isMissingCardNumberColumnError`)に合わせる)。
 */
export function isMissingCardPackNamesColumnError(error: unknown): boolean {
  if (!error) return false;

  return isPgMissingNamedColumnError(error, ["card_pack_names"]);
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

  return isPgMissingNamedColumnError(error, ["default_card_pack_name"]);
}

/**
 * Detect the "rename_card_pack RPC is not deployed yet" error.
 *
 * Issue #554: `public.rename_card_pack` ships in migration 00063, in the same
 * PR as the PATCH /api/cards/collections route that calls it. During a rolling
 * deploy the app code can go live before the migration finishes, in which case
 * PostgreSQL reports `42883` (`undefined_function`) instead of the 42703 used
 * by missing-column detectors.
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

  return isPgMissingNamedColumnError(error, ["rarity_weights_scope"]);
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

  return isPgMissingNamedColumnError(error, ["pack_rarity_weights"]);
}

export type CollectionExistenceResult =
  | "exists" // at least one active card belongs to this pack
  | "absent"; // no active card belongs to this pack → would cause empty draws

/**
 * checkCollectionHasActiveCards の pg 直結実装 (#663)
 *
 * 旧 PostgREST 実装との対応:
 * - `{ count: "exact", head: true }` は drizzle-orm の count() ヘルパー
 *   （`sql`count(*)`.mapWith(Number)` 相当）で件数のみ取得する形に置き換える。
 * - DEFAULT_PACK_SENTINEL の場合は isNull(collection_name)、それ以外は
 *   eq(collection_name, collectionName)（postgrest 経路と同じ分岐）。
 * - 想定外のエラーは throw して呼び出し元で 500 にする（既存と同じ）。
 *
 * #954: 以前は cards.collection_name 列の欠落（42703）を `schema-not-ready`
 * として呼び出し元へ返し、検証をスキップするデプロイ窓フォールバックを持って
 * いたが、#834 (PR #953) と同じ手順で PlanetScale 本番・preview の
 * information_schema.columns 実測により cards.collection_name の実在を確認した
 * ため撤去した（Issue #954）。列が実在する環境では 42703 は発生せず、
 * フォールバックは死に分岐だった。エラーは素通しされる単一経路。
 */
async function checkCollectionHasActiveCardsPg(
  streamerId: string,
  collectionName: string
): Promise<CollectionExistenceResult> {
  const collectionCondition =
    collectionName === DEFAULT_PACK_SENTINEL
      ? isNull(cardsTable.collection_name)
      : eq(cardsTable.collection_name, collectionName);

  // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
  const rows = await withDbRetry(
    async () => {
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
}

/**
 * Check whether a streamer has at least one ACTIVE card in the given pack.
 *
 * Gacha only draws from `is_active = true` cards, so a pack made of only inactive
 * cards must be rejected at save time — otherwise live redemptions fail with
 * "No cards available".
 *
 * ガチャは is_active=true のみを抽選するため、非アクティブのみのパックは保存時に
 * 弾く(本番引換で空抽選になるのを防ぐ)。
 */
export async function checkCollectionHasActiveCards(
  streamerId: string,
  collectionName: string
): Promise<CollectionExistenceResult> {
  return checkCollectionHasActiveCardsPg(streamerId, collectionName);
}
