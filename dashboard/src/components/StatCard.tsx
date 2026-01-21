import { ReactNode } from 'react'

interface StatCardProps {
  title: string
  value: string | number
  // Optional icon to display (emoji or component)
  icon?: ReactNode
  // Optional description or subtitle
  description?: string
  // Optional color theme for the card accent
  color?: 'blue' | 'green' | 'purple' | 'amber' | 'gray'
  // Loading state - shows skeleton while data is being fetched
  loading?: boolean
}

// Color mappings for the card accent border
const colorClasses = {
  blue: 'border-blue-500',
  green: 'border-green-500',
  purple: 'border-purple-500',
  amber: 'border-amber-500',
  gray: 'border-gray-500',
}

/**
 * StatCard component for displaying key metrics
 * Used throughout the dashboard to show statistics like total users, battles, etc.
 */
export function StatCard({
  title,
  value,
  icon,
  description,
  color = 'blue',
  loading = false,
}: StatCardProps) {
  return (
    <div
      className={`bg-white rounded-lg shadow p-6 border-l-4 ${colorClasses[color]}`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500 font-medium">{title}</p>
          {loading ? (
            // Skeleton loader for value
            <div className="h-8 w-24 bg-gray-200 animate-pulse rounded mt-1" />
          ) : (
            <p className="text-2xl font-bold text-gray-900 mt-1">
              {typeof value === 'number' ? value.toLocaleString() : value}
            </p>
          )}
          {description && (
            <p className="text-xs text-gray-400 mt-1">{description}</p>
          )}
        </div>
        {icon && (
          <div className="text-3xl opacity-50">{icon}</div>
        )}
      </div>
    </div>
  )
}
