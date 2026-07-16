import { useEffect, useRef, useState } from 'react'
import { adminApi } from '../lib/adminApi'
import { DataTable } from '../components/DataTable'
import { ErrorBanner } from '../components/ErrorBanner'
import type { SupportInquiry, SupportInquiryMessage, InquiryStatus } from '../types/database'

// ステータスの色定義
const STATUS_OPTIONS = [
  { value: 'open', label: 'Open', color: 'bg-yellow-100 text-yellow-800' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-blue-100 text-blue-800' },
  { value: 'resolved', label: 'Resolved', color: 'bg-green-100 text-green-800' },
  { value: 'closed', label: 'Closed', color: 'bg-gray-100 text-gray-600' },
] as const

// カテゴリの色定義
const CATEGORY_OPTIONS = [
  { value: 'bug', label: 'Bug', color: 'bg-red-100 text-red-800' },
  { value: 'feature', label: 'Feature', color: 'bg-purple-100 text-purple-800' },
  { value: 'other', label: 'Other', color: 'bg-gray-100 text-gray-600' },
] as const

/**
 * 問い合わせ管理ページ（analysis管理ダッシュボード用）
 * 問い合わせの一覧表示、ステータス変更、返信を行う
 */
export function SupportInquiries() {
  const [inquiries, setInquiries] = useState<SupportInquiry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 再試行ボタン用のトリガー（値自体に意味は無く、変更するとeffectを再実行させる）
  const [retryToken, setRetryToken] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  // ステータスフィルタ
  const [statusFilter, setStatusFilter] = useState<string>('all')
  // 選択中の問い合わせ（詳細表示用）
  const [selectedInquiry, setSelectedInquiry] = useState<SupportInquiry | null>(null)
  const [messages, setMessages] = useState<SupportInquiryMessage[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [messagesError, setMessagesError] = useState<string | null>(null)
  // 返信フォーム
  const [replyBody, setReplyBody] = useState('')
  const [sending, setSending] = useState(false)

  // 問い合わせ一覧を取得。以前は取得完了後の反映を防ぐガードすら無く、
  // statusFilterを素早く連続変更すると古いレスポンスが後から返って新しい表示を
  // 上書きしうる問題があった。AbortControllerでリクエスト自体を中断し、
  // 中断時はエラー表示もloading解除もしない(次の新しいリクエストが担当する)
  useEffect(() => {
    const controller = new AbortController()
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        setInquiries(await adminApi.getSupportInquiries(statusFilter, { signal: controller.signal }))
      } catch (err) {
        // エラーの型ではなくsignal自体の状態で中断済みかどうかを判定する
        // (理由はGacha.tsxの同種コメント参照)
        if (controller.signal.aborted) return
        console.error('Failed to fetch inquiries:', err)
        setError((err instanceof Error && err.message) || '問い合わせ一覧の取得に失敗しました')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    run()
    return () => controller.abort()
  }, [statusFilter, retryToken])

  // メッセージ取得。行Aをクリック(応答が遅い)→行Bをクリック、という操作をすると、
  // 中断せずに放置した場合Aのレスポンスが後から届いてBの詳細表示中にAのメッセージが
  // 表示されてしまい、管理者がAの内容をBの問い合わせだと誤認したまま返信する事故に
  // つながる(返信はselectedInquiry.id宛のため実害が大きい)。前回のリクエストを
  // messagesAbortRefで追跡し、新しいクリックのたびに確実に中断する
  const messagesAbortRef = useRef<AbortController | null>(null)

  const fetchMessages = async (inquiryId: string) => {
    messagesAbortRef.current?.abort()
    const controller = new AbortController()
    messagesAbortRef.current = controller

    setLoadingMessages(true)
    setMessagesError(null)
    try {
      const data = await adminApi.getSupportInquiryMessages(inquiryId, { signal: controller.signal })
      setMessages(data)
    } catch (error) {
      if (controller.signal.aborted) return
      console.error('Failed to fetch messages:', error)
      setMessagesError((error instanceof Error && error.message) || 'メッセージの取得に失敗しました')
    } finally {
      if (!controller.signal.aborted) setLoadingMessages(false)
    }
  }

  // アンマウント時、進行中のメッセージ取得があれば中断する
  useEffect(() => {
    return () => messagesAbortRef.current?.abort()
  }, [])

  // 行クリックで詳細表示
  const handleRowClick = (inquiry: SupportInquiry) => {
    setSelectedInquiry(inquiry)
    setReplyBody('')
    fetchMessages(inquiry.id)
  }

  // ステータス変更
  const handleStatusChange = async (inquiryId: string, newStatus: InquiryStatus) => {
    try {
      await adminApi.updateSupportInquiryStatus(inquiryId, newStatus)

      // ローカル状態を更新
      setInquiries(prev => prev.map(i =>
        i.id === inquiryId ? { ...i, status: newStatus } : i
      ))
      if (selectedInquiry?.id === inquiryId) {
        setSelectedInquiry(prev => prev ? { ...prev, status: newStatus } : null)
      }
    } catch (error) {
      console.error('Failed to update status:', error)
      alert('Failed to update status')
    }
  }

  // 管理者返信
  const handleReply = async () => {
    if (!selectedInquiry || !replyBody.trim()) return

    setSending(true)
    try {
      await adminApi.createSupportInquiryReply(selectedInquiry.id, replyBody.trim())

      setReplyBody('')
      fetchMessages(selectedInquiry.id)
    } catch (error) {
      console.error('Failed to send reply:', error)
      alert('Failed to send reply')
    } finally {
      setSending(false)
    }
  }

  // テーブル列定義
  const columns = [
    {
      key: 'twitch_display_name',
      header: 'User',
      render: (item: SupportInquiry) => (
        <span className="font-medium">{item.twitch_display_name}</span>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (item: SupportInquiry) => {
        const cat = CATEGORY_OPTIONS.find(c => c.value === item.category)
        return (
          <span className={`rounded-full px-2 py-1 text-xs font-medium ${cat?.color || ''}`}>
            {cat?.label || item.category}
          </span>
        )
      },
    },
    {
      key: 'subject',
      header: 'Subject',
      render: (item: SupportInquiry) => (
        <div className="max-w-xs truncate">{item.subject}</div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (item: SupportInquiry) => (
        <select
          value={item.status}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation()
            handleStatusChange(item.id, e.target.value as InquiryStatus)
          }}
          className={`rounded-full px-2 py-1 text-xs font-medium border-0 cursor-pointer ${
            STATUS_OPTIONS.find(s => s.value === item.status)?.color || ''
          }`}
        >
          {STATUS_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'created_at',
      header: 'Created',
      render: (item: SupportInquiry) => (
        <span className="text-sm text-gray-500">
          {new Date(item.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ]

  // 統計サマリー
  const openCount = inquiries.filter(i => i.status === 'open').length
  const inProgressCount = inquiries.filter(i => i.status === 'in_progress').length

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Support Inquiries</h1>
        <p className="text-sm text-gray-500 mt-1">Manage user inquiries and replies</p>
      </div>

      <div className="mb-6">
        <ErrorBanner messages={[error]} onRetry={() => setRetryToken((t) => t + 1)} />
      </div>

      {/* 統計サマリー */}
      <div className="mb-6 grid grid-cols-3 gap-4">
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Open</p>
          <p className="text-2xl font-bold text-yellow-600">{openCount}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">In Progress</p>
          <p className="text-2xl font-bold text-blue-600">{inProgressCount}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Total</p>
          <p className="text-2xl font-bold">{inquiries.length}</p>
        </div>
      </div>

      {/* ステータスフィルタ */}
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setStatusFilter('all')}
          className={`rounded-full px-3 py-1 text-sm ${statusFilter === 'all' ? 'bg-gray-800 text-white' : 'bg-gray-200 text-gray-600'}`}
        >
          All
        </button>
        {STATUS_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setStatusFilter(opt.value)}
            className={`rounded-full px-3 py-1 text-sm ${statusFilter === opt.value ? 'bg-gray-800 text-white' : 'bg-gray-200 text-gray-600'}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* 問い合わせ一覧 */}
      <DataTable
        columns={columns}
        data={inquiries}
        keyExtractor={(item) => item.id}
        loading={loading}
        emptyMessage="No inquiries yet"
        onRowClick={handleRowClick}
        pagination={{
          currentPage,
          pageSize,
          onPageChange: setCurrentPage,
          onPageSizeChange: (size) => { setPageSize(size); setCurrentPage(1) },
          pageSizeOptions: [10, 20, 50],
        }}
      />

      {/* 詳細パネル（モーダル風） */}
      {selectedInquiry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{selectedInquiry.subject}</h2>
              <button
                onClick={() => setSelectedInquiry(null)}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* メタ情報 */}
            <div className="mb-4 flex flex-wrap gap-2 text-sm">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                CATEGORY_OPTIONS.find(c => c.value === selectedInquiry.category)?.color || ''
              }`}>
                {CATEGORY_OPTIONS.find(c => c.value === selectedInquiry.category)?.label}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                STATUS_OPTIONS.find(s => s.value === selectedInquiry.status)?.color || ''
              }`}>
                {STATUS_OPTIONS.find(s => s.value === selectedInquiry.status)?.label}
              </span>
              <span className="text-gray-500">
                {selectedInquiry.twitch_display_name} - {new Date(selectedInquiry.created_at).toLocaleString()}
              </span>
            </div>

            {/* 初回投稿 */}
            <div className="mb-4 rounded-lg bg-gray-50 p-4">
              <p className="whitespace-pre-wrap text-sm">{selectedInquiry.body}</p>
            </div>

            {/* メッセージスレッド */}
            <ErrorBanner
              messages={[messagesError]}
              onRetry={() => fetchMessages(selectedInquiry.id)}
            />
            {loadingMessages ? (
              <p className="text-center text-sm text-gray-400">Loading messages...</p>
            ) : (
              <div className="mb-4 space-y-3">
                {messages.map(msg => (
                  <div
                    key={msg.id}
                    className={`rounded-lg p-3 ${
                      msg.sender_type === 'admin'
                        ? 'bg-blue-50 border border-blue-200'
                        : 'bg-gray-50 border border-gray-200'
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <span className={`font-medium ${msg.sender_type === 'admin' ? 'text-blue-600' : 'text-gray-600'}`}>
                        {msg.sender_type === 'admin' ? 'Admin' : 'User'}
                      </span>
                      <span className="text-gray-400">
                        {new Date(msg.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{msg.body}</p>
                  </div>
                ))}
              </div>
            )}

            {/* 返信フォーム */}
            <div className="border-t pt-4">
              <textarea
                value={replyBody}
                onChange={e => setReplyBody(e.target.value)}
                className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                rows={3}
                placeholder="Type your reply as admin..."
                maxLength={2000}
              />
              <div className="flex justify-end">
                <button
                  onClick={handleReply}
                  disabled={sending || !replyBody.trim()}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {sending ? 'Sending...' : 'Reply as Admin'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
