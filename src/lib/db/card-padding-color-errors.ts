// -----------------------------------------------------------------------------
// cards テーブルの image_padding_color 列（#899）専用のデプロイ窓フォールバック。
// card-number-errors.ts / card-issuance.ts と同じ粒度の単一列ヘルパー。
// 旧「本番未デプロイ8列」フォールバックの経緯は Issue #834 参照
// （2026-08 撤去。ファイルは cards-safe-columns.ts から改名）。
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
