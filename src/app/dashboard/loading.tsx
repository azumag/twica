/**
 * Dashboard loading skeleton
 * Displayed immediately during page transitions while data is being fetched.
 * This improves perceived performance by showing instant feedback.
 *
 * ダッシュボードのローディングスケルトン
 * データ取得中のページ遷移時に即座に表示される。
 * 即座のフィードバックを表示することで体感パフォーマンスを向上。
 */
export default function DashboardLoading() {
  return (
    <div className="animate-pulse">
      {/* Header skeleton */}
      <div className="mb-8">
        <div className="h-8 w-48 bg-gray-700 rounded mb-2" />
        <div className="h-4 w-64 bg-gray-700 rounded" />
      </div>

      {/* Stats skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-gray-800 rounded-xl p-4">
            <div className="h-4 w-20 bg-gray-700 rounded mb-2" />
            <div className="h-8 w-16 bg-gray-700 rounded" />
          </div>
        ))}
      </div>

      {/* Content skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="bg-gray-800 rounded-lg overflow-hidden">
            <div className="aspect-square bg-gray-700" />
            <div className="p-3">
              <div className="h-4 w-24 bg-gray-700 rounded mb-2" />
              <div className="h-3 w-16 bg-gray-700 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
