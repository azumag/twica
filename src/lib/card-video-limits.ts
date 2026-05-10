import { PLAN_VIDEO_CARD_LIMIT } from "@/lib/plan-constants";
import type { PlanType } from "@/lib/plan-constants";
import type { getSupabaseAdmin } from "@/lib/supabase/admin";

export function getVideoCardLimit(plan: PlanType): number {
  return PLAN_VIDEO_CARD_LIMIT[plan];
}

export async function countVideoCardsForStreamer(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  excludeCardId?: string
): Promise<number> {
  let query = supabaseAdmin
    .from("cards")
    .select("id", { count: "exact", head: true })
    .eq("streamer_id", streamerId)
    .eq("media_type", "video");

  if (excludeCardId) {
    query = query.neq("id", excludeCardId);
  }

  const { count, error } = await query;
  if (error) {
    throw error;
  }

  return count ?? 0;
}
