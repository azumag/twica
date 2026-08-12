// -----------------------------------------------------------------------------
// cards テーブルの列欠落フォールバック用ヘルパー。
//
// 「本番未デプロイ8列」（card_number, hp, atk, def, spd, skill_type, skill_name,
// skill_power）に対するフォールバック（CARDS_SAFE_COLUMNS /
// withCardsBattleColumnFallback / isMissingCardsBattleColumnError）は、
// PlanetScale 本番の information_schema.columns への実測で8列とも実在することを
// 確認したため撤去した（Issue #834。実測結果は同issueのコメント参照）。列定義
// 自体は将来のカードバトル機能の土台として schema.ts に残す（#625/#628 の既存
// 方針どおり）が、本番に実在するため無指定 select/returning は常に成功しており、
// このフォールバックが担っていた分岐は死に分岐だった。
//
// 引き続き必要なのは image_padding_color 列（#899、本Issueとは独立した別の
// デプロイ窓）に対するフォールバックのみ。
// -----------------------------------------------------------------------------

import { getTableColumns } from "drizzle-orm";
import { cards as cardsTable } from "@/lib/db/schema";
import { isPgMissingNamedColumnError } from "@/lib/db/errors";

/**
 * image_padding_color 列の欠落（migration 未適用の本番DB）を検知する（#899）。
 * INSERT/UPDATE にこの列が含まれると、列が未適用の環境では全体が失敗するため、
 * 列欠落時は該当フィールドを落として再試行する（余白情報だけが保存されない）。
 */
export function isMissingCardPaddingColorError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, ["image_padding_color"]);
}

/**
 * cards の全列から image_padding_color だけを除いた明示列オブジェクト（#899）。
 *
 * Drizzle の無指定 `.returning()` は schema.ts の静的列リストを生成するため、
 * image_padding_color 列が未適用の環境では RETURNING 自体が失敗する
 * （insertData/updateData から該当フィールドを削除するだけでは直らない —
 * RETURNING は VALUES/SET の内容と無関係に schema.ts の全列を要求するため）。
 * INSERT/UPDATE の RETURNING をこの列リストへ切り替えて再試行することで、
 * image_padding_color を送らないリクエストも含めて対応する
 * （src/app/api/cards/route.ts, src/app/api/cards/[id]/route.ts 参照）。
 */
const { image_padding_color: _imagePaddingColor, ...cardsColumnsWithoutPaddingColor } =
  getTableColumns(cardsTable);
export const CARDS_COLUMNS_WITHOUT_PADDING_COLOR = cardsColumnsWithoutPaddingColor;
