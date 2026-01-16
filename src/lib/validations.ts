import { getSupabaseAdmin } from './supabase/admin'

export async function validateDropRateSum(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  newDropRate: number,
  excludeCardId?: string
): Promise<{ valid: boolean; error?: string }> {
  const { data: cards, error } = await supabaseAdmin
    .from('cards')
    .select('id, drop_rate')
    .eq('streamer_id', streamerId)
    .eq('is_active', true)

  if (error) {
    return { valid: false, error: 'Failed to validate drop rates' }
  }

  const currentSum = cards
    .filter((c) => c.id !== excludeCardId)
    .reduce((sum, c) => sum + (c.drop_rate || 0), 0)

  const newSum = currentSum + newDropRate

  if (newSum > 1.0) {
    return {
      valid: false,
      error: `Total drop rate would be ${(newSum * 100).toFixed(1)}% (max 100%). Current: ${(currentSum * 100).toFixed(1)}%, New: ${(newDropRate * 100).toFixed(1)}%`,
    }
  }

  return { valid: true }
}
