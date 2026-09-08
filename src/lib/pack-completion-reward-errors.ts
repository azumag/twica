import { getErrorChain } from '@/lib/db/errors';

export function getRewardCardProtectionPack(error: unknown): string | null {
  for (const layer of getErrorChain(error)) {
    if (typeof layer !== 'object' || layer === null) continue;
    const value = layer as { code?: string; detail?: string };
    if (value.code === 'P0720') return value.detail ?? '';
  }
  return null;
}
