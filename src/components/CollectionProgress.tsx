import { getLocale, getTranslations } from "next-intl/server";

interface CollectionProgressProps {
  // Number of unique card types the user owns
  // 所持しているユニークカード種類数
  owned: number;
  // Number of all active card types
  // 全アクティブカード種類数
  total: number;
  // 過去のコンプリート達成履歴（デフォルト空配列で後方互換）
  completionHistory?: { total_cards: number; completed_at: string }[];
}

/**
 * Collection progress display component
 * コレクション進捗表示コンポーネント
 *
 * - 現在コンプリート中 → 「コンプリート！」表示
 * - 過去履歴あり → 「全X種時にコンプリート達成（日時付き）」を表示
 */
export default async function CollectionProgress({
  owned,
  total,
  completionHistory = [],
}: CollectionProgressProps) {
  const locale = await getLocale();
  const t = await getTranslations("collectionProgress");

  const safeOwned = Math.max(0, owned);
  const safeTotal = Math.max(0, total);
  // Cap at 100% to handle edge cases (e.g., data inconsistency)
  // データ不整合時に100%を超えないよう上限を設定
  const percent = safeTotal > 0 ? Math.min(100, Math.round((safeOwned / safeTotal) * 100)) : 0;
  const isComplete = safeTotal > 0 && safeOwned >= safeTotal;
  const currentCompleteRecord = completionHistory.find(
    (record) => record.total_cards === safeTotal
  );
  const pastCompletionHistory = completionHistory.filter(
    (record) => !(isComplete && record.total_cards === safeTotal)
  );

  const formatDateTime = (value: string): string => {
    const completedDate = new Date(value);
    if (Number.isNaN(completedDate.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(completedDate);
  };

  return (
    <div
      className={`mb-8 rounded-xl border p-4 ${
        isComplete
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-gray-700 bg-gray-800"
      }`}
    >
      <div className="mb-3 flex items-center justify-between">
        <p className={`text-sm font-semibold ${isComplete ? "text-emerald-300" : "text-gray-200"}`}>
          {t("progress", { owned: safeOwned, total: safeTotal })}
        </p>
        <p className={`text-xs ${isComplete ? "text-emerald-300" : "text-gray-400"}`}>
          {t("progressBar", { percent })}
        </p>
      </div>

      <div className="h-2.5 overflow-hidden rounded-full bg-gray-700">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            isComplete ? "bg-emerald-400" : "bg-purple-500"
          }`}
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-label={t("progressBar", { percent })}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      {isComplete && (
        <div className="mt-3 space-y-1">
          <p className="text-sm font-semibold text-emerald-300">
            {t("complete")}
          </p>
          {currentCompleteRecord && (
            <p className="text-xs text-emerald-200/90">
              {t("currentCompleteAt", {
                dateTime: formatDateTime(currentCompleteRecord.completed_at),
              })}
            </p>
          )}
        </div>
      )}

      {/* 過去のコンプリート達成履歴を常に表示（履歴がある場合） */}
      {pastCompletionHistory.length > 0 && (
        <div className="mt-3 space-y-1">
          {pastCompletionHistory.map((record) => (
            <p key={`${record.total_cards}-${record.completed_at}`} className="text-xs text-amber-400">
              {t("pastCompleteWithDateTime", {
                totalCards: record.total_cards,
                dateTime: formatDateTime(record.completed_at),
              })}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
