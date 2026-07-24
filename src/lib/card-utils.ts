/**
 * PostgreSQL driverや履歴fixtureがDECIMALを文字列で返す場合にも備え、
 * drop_rateを数値へ正規化する。
 */
export function normalizeDropRate<T extends { drop_rate: unknown }>(cards: T[]): Array<T & { drop_rate: number }> {
  return cards.map(card => ({
    ...card,
    drop_rate: Number(card.drop_rate) || 0,
  }));
}
