// 交換対象の制限(出品カードごとのホワイトリスト)の上限。
// 設定画面(クライアントコンポーネント)と API / 書き込み処理が同じ値を使うため、DB を
// 読み込む src/lib/trade-wanted-restrictions.ts とは別の、依存の無いモジュールに置く。

/** 1つのルール(出品カード1枚)に入れられる許可カードの上限。 */
export const TRADE_WANTED_RESTRICTION_MAX_ITEMS = 100;
/** 配信者1人が持てるルール(出品カード)数の上限。 */
export const TRADE_WANTED_RESTRICTION_MAX_RULES = 200;
