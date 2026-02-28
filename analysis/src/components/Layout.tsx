import { NavLink, Outlet } from 'react-router-dom'

// Navigation item type for sidebar menu
interface NavItem {
  path: string
  label: string
  icon: string
}

// Sidebar navigation items for the dashboard
// Each item represents a different view/page in the admin panel
const navItems: NavItem[] = [
  { path: '/', label: 'Overview', icon: '📊' },
  { path: '/users', label: 'Users', icon: '👥' },
  { path: '/streamers', label: 'Streamers', icon: '🎮' },
  { path: '/gacha', label: 'Gacha', icon: '🎰' },
  { path: '/battles', label: 'Battles', icon: '⚔️' },
  { path: '/announcements', label: 'Announcements', icon: '📢' },
  { path: '/licenses', label: 'Licenses', icon: '🎫' },
  { path: '/inquiries', label: 'Inquiries', icon: '💬' },
]

/**
 * Main layout component for the dashboard
 * Provides a sidebar navigation and main content area
 * Uses Outlet from react-router-dom to render child routes
 */
export function Layout() {
  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar Navigation */}
      <aside className="w-64 bg-gray-800 text-white flex flex-col">
        {/* Dashboard Header */}
        <div className="p-4 border-b border-gray-700">
          <h1 className="text-xl font-bold">Twica Dashboard</h1>
          <p className="text-sm text-gray-400 mt-1">Admin Panel</p>
        </div>

        {/* Navigation Menu */}
        <nav className="flex-1 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center px-4 py-3 text-sm transition-colors ${
                  isActive
                    ? 'bg-gray-700 text-white border-l-4 border-blue-500'
                    : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                }`
              }
              // Use end prop for exact matching on the root path
              end={item.path === '/'}
            >
              <span className="mr-3">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Footer with read-only notice */}
        <div className="p-4 border-t border-gray-700">
          <p className="text-xs text-gray-500">
            Admin Panel
          </p>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-auto">
        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
