/**
 * Issue #642 子B / 子C 共有: 匿名ランキング API のレスポンス contract。
 *
 * サーバ側（src/lib/services/streamer-ranking.ts）とクライアント側
 * （src/components/StreamerRanking.tsx）が同一の型を参照するための純粋な型定義。
 * ランタイム依存を一切持たない（`server-only` を import できないクライアント
 * コンポーネントから安全に読める）ため、DB へ触れるサービス層とは分離している。
 *
 * 匿名化境界は DB 関数 `public.get_streamer_ranking(uuid)` の応答生成時点で完結しており、
 * 他チャンネルの `streamer_id` / 名前 / アイコン等の識別子を表すフィールドはこの
 * contract に定義しない（受け取る余地・表示する余地を作らない）。子C の UI は
 * ここに無い情報を描画できない。
 */

/** DB 関数とアプリの contract バージョン。不一致は fail loud（サービス層で検証）。 */
export const STREAMER_RANKING_SCHEMA_VERSION = 1;

export type RankingMetric = "draws" | "card_count";
export type RankingPeriod = "daily" | "weekly" | "total" | "current";

/**
 * 匿名化済みのランキング1行。
 * 順位と数値のみを持ち、どのチャンネルの行かを示す情報は存在しない。
 */
export interface StreamerRankingRow {
  /** 表示用の順位（RANK()。同値は同順位で 1,1,3... と飛ぶ） */
  rank: number;
  value: number;
  /** 自分の行かどうか。UI はこれを紫ハイライト + 「あなた」バッジの根拠にする */
  isSelf: boolean;
}

/** 自分の行の値。母集団外・データ不足で順位が無いときは rank / percentile が null。 */
export interface StreamerRankingSelf {
  value: number;
  rank: number | null;
  /** 表示 rank 基準の百分位。下位半分では null（UI で「上位◯%」を出さない） */
  percentile: number | null;
}

export interface StreamerRankingEntry {
  metric: RankingMetric;
  period: RankingPeriod;
  /** 母集団チャンネル数（= 順位の分母） */
  participantCount: number;
  /** participantCount < 5。匿名性が壊れるため top/neighbors は空で返る */
  insufficientData: boolean;
  self: StreamerRankingSelf | null;
  /** position <= 10 の行 */
  top: StreamerRankingRow[];
  /** 自分の position ± 2 から top を除いた行（自分を含みうる） */
  neighbors: StreamerRankingRow[];
}

export interface StreamerRankingResponse {
  schemaVersion: typeof STREAMER_RANKING_SCHEMA_VERSION;
  /** バッチ集計の実行時刻。backfill 前など未生成のときは null */
  computedAt: string | null;
  rankings: StreamerRankingEntry[];
}
