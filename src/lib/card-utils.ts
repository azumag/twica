/**
 * Supabase JS clientがPostgreSQLのDECIMAL型を文字列で返す場合がある問題への対処
 * drop_rateを数値に正規化する
 */
export function normalizeDropRate<T extends { drop_rate: unknown }>(cards: T[]): Array<T & { drop_rate: number }> {
  return cards.map(card => ({
    ...card,
    drop_rate: Number(card.drop_rate) || 0,
  }));
}
