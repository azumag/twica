import { lazy, Suspense, type ReactNode } from 'react'
import { Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'

// 各画面はOverviewの初回表示には不要で、Gacha画面はrechartsも読み込むため、
// 全ページを静的importすると初回JSにすべての画面コードが含まれてしまう。
// React.lazyのdynamic importに切り替えることで、Viteがルートごとのチャンクを
// 生成し、ユーザーが実際に遷移した画面だけをダウンロードできる。
// named exportのページをReact.lazyで扱うにはdefault exportへの変換が必要なため、
// 各loaderのthenでページコンポーネントをdefaultとして返す。
const Overview = lazy(() =>
  import('./pages/Overview').then(({ Overview: Page }) => ({ default: Page }))
)
const Users = lazy(() => import('./pages/Users').then(({ Users: Page }) => ({ default: Page })))
const UserCards = lazy(() =>
  import('./pages/UserCards').then(({ UserCards: Page }) => ({ default: Page }))
)
const Streamers = lazy(() =>
  import('./pages/Streamers').then(({ Streamers: Page }) => ({ default: Page }))
)
const StreamerCards = lazy(() =>
  import('./pages/StreamerCards').then(({ StreamerCards: Page }) => ({ default: Page }))
)
const StreamerGachaHistory = lazy(() =>
  import('./pages/StreamerGachaHistory').then(({ StreamerGachaHistory: Page }) => ({
    default: Page,
  }))
)
const Gacha = lazy(() => import('./pages/Gacha').then(({ Gacha: Page }) => ({ default: Page })))
const Announcements = lazy(() =>
  import('./pages/Announcements').then(({ Announcements: Page }) => ({ default: Page }))
)
const Licenses = lazy(() =>
  import('./pages/Licenses').then(({ Licenses: Page }) => ({ default: Page }))
)
const SupportInquiries = lazy(() =>
  import('./pages/SupportInquiries').then(({ SupportInquiries: Page }) => ({ default: Page }))
)

/**
 * 画面チャンク取得中に表示する軽量なfallback。
 * Layoutの外側ではなくRoutesの内側に置くことで、ナビゲーションを維持したまま
 * 画面領域だけを置き換える。ユーザーが通信完了を待つ間も現在の操作対象が分かる
 * ように、単なる空白ではなく画面見出し相当のスケルトンを表示する。
 */
function RouteLoadingFallback() {
  return (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="画面を読み込み中">
      <div className="h-8 w-48 rounded bg-gray-200 animate-pulse" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="h-24 rounded-lg bg-white shadow animate-pulse" />
        ))}
      </div>
      <div className="h-64 rounded-lg bg-white shadow animate-pulse" />
    </div>
  )
}

/**
 * すべての遅延ルートで同じSuspense境界を使う。
 * ルートごとにfallbackの実装を複製すると画面追加時に表示仕様がずれるため、
 * チャンク読み込み中のUXをここで一元化する。
 */
function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteLoadingFallback />}>{children}</Suspense>
}

/**
 * Main App component with routing configuration
 * All routes are nested under the Layout component for consistent navigation
 */
function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        {/* Overview is the default landing page (index route) */}
        <Route
          index
          element={
            <LazyPage>
              <Overview />
            </LazyPage>
          }
        />
        <Route
          path="users"
          element={
            <LazyPage>
              <Users />
            </LazyPage>
          }
        />
        {/* ユーザーごとのカード一覧ページ */}
        <Route
          path="users/:userId/cards"
          element={
            <LazyPage>
              <UserCards />
            </LazyPage>
          }
        />
        <Route
          path="streamers"
          element={
            <LazyPage>
              <Streamers />
            </LazyPage>
          }
        />
        {/* ストリーマーごとのカード一覧ページ */}
        <Route
          path="streamers/:streamerId/cards"
          element={
            <LazyPage>
              <StreamerCards />
            </LazyPage>
          }
        />
        {/* ストリーマーごとのガチャ履歴ページ */}
        <Route
          path="streamers/:streamerId/gacha"
          element={
            <LazyPage>
              <StreamerGachaHistory />
            </LazyPage>
          }
        />
        <Route
          path="gacha"
          element={
            <LazyPage>
              <Gacha />
            </LazyPage>
          }
        />
        <Route
          path="announcements"
          element={
            <LazyPage>
              <Announcements />
            </LazyPage>
          }
        />
        <Route
          path="licenses"
          element={
            <LazyPage>
              <Licenses />
            </LazyPage>
          }
        />
        <Route
          path="inquiries"
          element={
            <LazyPage>
              <SupportInquiries />
            </LazyPage>
          }
        />
      </Route>
    </Routes>
  )
}

export default App
