"use client";

import { useLocale, useTranslations } from "next-intl";

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
 *
 * Issue #557: Server Component から Client Component へ変換。パックフィルタ
 * (CollectionPackFilter, クライアント状態でパック切替) 内で選択中パックの
 * 進捗表示として再利用するため。翻訳の取得が next-intl/server の
 * getTranslations/getLocale から next-intl の hooks に変わるだけで、
 * 描画内容・挙動は不変 (Server Component 配下からの利用も従来どおり可能)。
 */
export default function CollectionProgress({
  owned,
  total,
  completionHistory = [],
}: CollectionProgressProps) {
  const locale = useLocale();
  const t = useTranslations("collectionProgress");

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
          <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-300">
            {/* ゴールド勲章: 現在コンプリート中を示すメダルアイコン */}
            <svg className="w-5 h-5 text-yellow-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 2l2 4h4l2-4H8z" opacity="0.7" />
              <circle cx="12" cy="14" r="7" />
              <path d="M12 9l1.5 3 3.5.5-2.5 2.5.5 3.5L12 16.5 9 18.5l.5-3.5L7 12.5l3.5-.5z" fill="white" opacity="0.3" />
            </svg>
            {t("complete")}
          </p>
          {currentCompleteRecord && (
            // formatDateTime は Intl.DateTimeFormat に timeZone を指定していないため、
            // SSR (Cloudflare Workers = UTC) とクライアント（ユーザーのローカルTZ）で
            // 整形結果が異なりうる。これは「ユーザーのローカルタイムゾーンで達成日時を
            // 表示する」という意図した挙動であり、hydration mismatch ではない。
            // timeZone を固定すると全ユーザーにその TZ を強制してしまうため不採用とし、
            // React 公式にタイムスタンプ用途で認められている suppressHydrationWarning で
            // 警告を抑制する。
            <p className="text-xs text-emerald-200/90" suppressHydrationWarning>
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
            // 上と同様、達成日時はユーザーのローカルTZで表示する意図した挙動のため
            // suppressHydrationWarning でSSR/クライアント間の差分警告を抑制する。
            <p
              key={`${record.total_cards}-${record.completed_at}`}
              className="text-xs text-gray-300"
              suppressHydrationWarning
            >
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
