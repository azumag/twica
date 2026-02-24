import { ReactNode } from 'react'

interface Column<T> {
  key: string
  header: string
  // Render function allows custom cell rendering
  // Second parameter (index) is optional for ranking displays
  render?: (item: T, index: number) => ReactNode
  // Optional CSS class for the column
  className?: string
}

// ページネーション設定
interface PaginationConfig {
  currentPage: number
  pageSize: number
  // サーバーサイドページネーション用: 設定時はdata.lengthではなくこの値を使い、data.slice()をスキップ
  totalItems?: number
  onPageChange: (page: number) => void
  // ページサイズ変更（オプション）
  onPageSizeChange?: (size: number) => void
  // 利用可能なページサイズ（オプション）
  pageSizeOptions?: number[]
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  // Key extractor for React list rendering
  keyExtractor: (item: T) => string
  // Loading state
  loading?: boolean
  // Empty state message
  emptyMessage?: string
  // Optional row click handler
  onRowClick?: (item: T) => void
  // ページネーション設定（オプション）
  pagination?: PaginationConfig
}

/**
 * Reusable data table component for displaying lists of items
 * Supports custom column rendering, loading states, empty states, and pagination
 */
export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  loading = false,
  emptyMessage = 'No data available',
  onRowClick,
  pagination,
}: DataTableProps<T>) {
  // サーバーサイドページネーション: totalItems指定時はデータは既にページング済みなのでslice不要
  const isServerPagination = pagination?.totalItems !== undefined
  const totalItems = isServerPagination ? pagination!.totalItems! : data.length
  const totalPages = pagination ? Math.ceil(totalItems / pagination.pageSize) : 1
  const startIndex = pagination ? (pagination.currentPage - 1) * pagination.pageSize : 0
  const endIndex = pagination ? startIndex + pagination.pageSize : totalItems
  const displayData = isServerPagination ? data : (pagination ? data.slice(startIndex, endIndex) : data)

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${col.className || ''}`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {/* Skeleton rows while loading */}
            {[...Array(5)].map((_, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td key={col.key} className="px-6 py-4">
                    <div className="h-4 bg-gray-200 animate-pulse rounded w-3/4" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-8 text-center">
        <p className="text-gray-500">{emptyMessage}</p>
      </div>
    )
  }

  const canGoPrev = pagination ? pagination.currentPage > 1 : false
  const canGoNext = pagination ? pagination.currentPage < totalPages : false

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${col.className || ''}`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {displayData.map((item, index) => (
              <tr
                key={keyExtractor(item)}
                className={onRowClick ? 'hover:bg-gray-50 cursor-pointer' : ''}
                onClick={() => onRowClick?.(item)}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-6 py-4 whitespace-nowrap text-sm ${col.className || ''}`}
                  >
                    {col.render
                      ? col.render(item, startIndex + index)
                      : String((item as Record<string, unknown>)[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* ページネーションコントロール（インラインJSX — レンダリング関数内でコンポーネント定義するとアンマウント/マウントが繰り返されるため） */}
      {pagination && totalItems > 0 && (
        <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm text-gray-500">
            {totalItems}件中 {startIndex + 1}-{Math.min(endIndex, totalItems)}件を表示
          </div>
          <div className="flex items-center gap-4">
            {pagination.onPageSizeChange && pagination.pageSizeOptions && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">表示:</span>
                <select
                  value={pagination.pageSize}
                  onChange={(e) => pagination.onPageSizeChange!(Number(e.target.value))}
                  className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {pagination.pageSizeOptions.map((size) => (
                    <option key={size} value={size}>
                      {size}件
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={() => pagination.onPageChange(1)}
                disabled={!canGoPrev}
                className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                title="最初のページ"
              >
                &laquo;
              </button>
              <button
                onClick={() => pagination.onPageChange(pagination.currentPage - 1)}
                disabled={!canGoPrev}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                前へ
              </button>
              <span className="text-sm text-gray-700 px-2">
                {pagination.currentPage} / {totalPages}
              </span>
              <button
                onClick={() => pagination.onPageChange(pagination.currentPage + 1)}
                disabled={!canGoNext}
                className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                次へ
              </button>
              <button
                onClick={() => pagination.onPageChange(totalPages)}
                disabled={!canGoNext}
                className="px-2 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                title="最後のページ"
              >
                &raquo;
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
