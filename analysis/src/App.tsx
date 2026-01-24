import { Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Overview } from './pages/Overview'
import { Users } from './pages/Users'
import { UserCards } from './pages/UserCards'
import { Streamers } from './pages/Streamers'
import { StreamerCards } from './pages/StreamerCards'
import { StreamerGachaHistory } from './pages/StreamerGachaHistory'
import { Gacha } from './pages/Gacha'
import { Battles } from './pages/Battles'

/**
 * Main App component with routing configuration
 * All routes are nested under the Layout component for consistent navigation
 */
function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        {/* Overview is the default landing page (index route) */}
        <Route index element={<Overview />} />
        <Route path="users" element={<Users />} />
        {/* ユーザーごとのカード一覧ページ */}
        <Route path="users/:userId/cards" element={<UserCards />} />
        <Route path="streamers" element={<Streamers />} />
        {/* ストリーマーごとのカード一覧ページ */}
        <Route path="streamers/:streamerId/cards" element={<StreamerCards />} />
        {/* ストリーマーごとのガチャ履歴ページ */}
        <Route path="streamers/:streamerId/gacha" element={<StreamerGachaHistory />} />
        <Route path="gacha" element={<Gacha />} />
        <Route path="battles" element={<Battles />} />
      </Route>
    </Routes>
  )
}

export default App
