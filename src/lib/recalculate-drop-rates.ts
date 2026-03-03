import type { Card } from "@/types/database";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { normalizeDropRate } from "@/lib/card-utils";
import { calculateDropRates } from "@/lib/rarity-weight-calculator";
import { logger } from "@/lib/logger";

/**
 * Recalculate active cards drop_rate when rarity auto mode is enabled.
 * Returns updated active cards, [] when no active cards exist, or null when auto mode is disabled.
 */
export async function recalculateIfAutoMode(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  rarityWeights: Record<string, number> | null
): Promise<Card[] | null> {
  // null = 未設定, {} = 手動モード明示 → いずれも自動再計算スキップ
  if (!rarityWeights || Object.keys(rarityWeights).length === 0) {
    return null;
  }

  const { data: activeCards, error: activeCardsError } = await supabaseAdmin
    .from("cards")
    .select("id, rarity, is_active, intra_rarity_weight")
    .eq("streamer_id", streamerId)
    .eq("is_active", true);

  if (activeCardsError) {
    throw activeCardsError;
  }

  const updates = calculateDropRates(activeCards || [], rarityWeights);
  if (updates.length === 0) {
    return [];
  }

  // drop_rateのみ更新。intra_rarity_weightはユーザーが設定した値をそのまま保持するため
  // RPCペイロードには含めない（calculateDropRatesで読み取り済み）
  const rpcPayload = updates.map((update) => ({
    id: update.id,
    drop_rate: update.dropRate,
  }));

  const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
    "batch_update_card_drop_rates",
    {
      p_streamer_id: streamerId,
      p_updates: rpcPayload,
    }
  );

  if (rpcError) {
    throw rpcError;
  }

  // 並行操作（別タブでのカード削除等）により件数が一致しない場合がある
  // 部分更新は正常動作のため、throwせずに警告ログのみ出力
  const updatedCount = rpcResult?.updated_count ?? 0;
  if (updatedCount !== updates.length) {
    logger.warn(
      `[recalculateIfAutoMode] Count mismatch: expected ${updates.length}, got ${updatedCount} (concurrent modification likely)`
    );
  }

  const updatedCardIds = updates.map((update) => update.id);
  const { data: recalculatedCards, error: recalculatedCardsError } = await supabaseAdmin
    .from("cards")
    .select("*")
    .eq("streamer_id", streamerId)
    .in("id", updatedCardIds);

  if (recalculatedCardsError) {
    throw recalculatedCardsError;
  }

  return normalizeDropRate((recalculatedCards || []) as Card[]);
}
