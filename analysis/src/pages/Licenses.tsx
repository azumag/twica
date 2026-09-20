import { useEffect, useRef, useState } from 'react'
import { adminApi, type LicenseWithUser, type TwitchSubUser } from '../lib/adminApi'
import { DataTable } from '../components/DataTable'
import { ErrorBanner } from '../components/ErrorBanner'
import type { SupportCode, SupportCodeStatus, PlanType } from '../types/database'

// プランタイプ表示用の設定
const PLAN_OPTIONS: { value: PlanType; label: string; color: string }[] = [
  { value: 'support', label: 'Supporter', color: 'bg-blue-100 text-blue-800' },
  { value: 'patron', label: 'Patron', color: 'bg-yellow-100 text-yellow-800' },
]

// コードステータス表示用の設定
const STATUS_OPTIONS: { value: SupportCodeStatus; label: string; color: string }[] = [
  { value: 'active', label: 'Active', color: 'bg-green-100 text-green-800' },
  { value: 'rotating', label: 'Rotating', color: 'bg-orange-100 text-orange-800' },
  { value: 'revoked', label: 'Revoked', color: 'bg-red-100 text-red-800' },
]

/**
 * ライセンス管理ページ（analysis管理ダッシュボード用）
 * 支援コードの一覧・生成・ステータス管理、およびユーザーライセンスの確認を行う
 *
 * コード生成フロー:
 * 1. ランダムコードを生成（crypto.getRandomValues）
 * 2. SHA-256ハッシュを計算
 * 3. ハッシュをDBに保存（平文は画面に一度だけ表示）
 */
export function Licenses() {
  const [codes, setCodes] = useState<SupportCode[]>([])
  const [licenses, setLicenses] = useState<LicenseWithUser[]>([])
  const [loading, setLoading] = useState(true)
  const [codesError, setCodesError] = useState<string | null>(null)
  const [licensesLoading, setLicensesLoading] = useState(true)
  const [licensesError, setLicensesError] = useState<string | null>(null)

  // コード生成フォーム
  const [showGenerateForm, setShowGenerateForm] = useState(false)
  const [newPlanType, setNewPlanType] = useState<PlanType>('support')
  const [newMemo, setNewMemo] = useState('')
  const [generating, setGenerating] = useState(false)
  // 生成直後の平文コード（一度だけ表示）
  const [generatedPlainCode, setGeneratedPlainCode] = useState<string | null>(null)
  // コード生成/revoke失敗時のエラー（#775: 従来はalert()で表示していたが
  // モーダルダイアログでタブ操作をブロックするためErrorBannerのインライン表示に統一）
  const [codesWriteError, setCodesWriteError] = useState<string | null>(null)

  // コード一覧ページネーション
  const [codesPage, setCodesPage] = useState(1)
  const [codesPageSize, setCodesPageSize] = useState(20)

  // ライセンス一覧ページネーション
  const [licensesPage, setLicensesPage] = useState(1)
  const [licensesPageSize, setLicensesPageSize] = useState(20)

  // Twitchサブスクユーザー一覧
  const [twitchSubs, setTwitchSubs] = useState<TwitchSubUser[]>([])
  const [twitchSubsLoading, setTwitchSubsLoading] = useState(true)
  const [twitchSubsError, setTwitchSubsError] = useState<string | null>(null)
  const [twitchSubsPage, setTwitchSubsPage] = useState(1)
  const [twitchSubsPageSize, setTwitchSubsPageSize] = useState(20)

  // タブ切り替え
  const [activeTab, setActiveTab] = useState<'codes' | 'licenses' | 'twitch_subs'>('codes')

  // Twitchサブスク数
  const [twitchSubCount, setTwitchSubCount] = useState(0)

  // 3つとも、マウント時に加えてミューテーション成功後の再取得でも呼ばれるため、
  // それぞれ専用のAbortControllerRefで前回リクエストを追跡し、素早い連続呼び出しでも
  // 実際にリクエストを中断できるようにする（3つは互いに独立したデータ・loading
  // stateのため、controllerも個別に持つ）
  const codesAbortRef = useRef<AbortController | null>(null)
  const licensesAbortRef = useRef<AbortController | null>(null)
  const twitchSubsAbortRef = useRef<AbortController | null>(null)

  // コード一覧を取得
  const fetchCodes = async () => {
    codesAbortRef.current?.abort()
    const controller = new AbortController()
    codesAbortRef.current = controller

    setLoading(true)
    setCodesError(null)
    try {
      setCodes(await adminApi.getSupportCodes({ signal: controller.signal }))
    } catch (err) {
      if (controller.signal.aborted) return
      console.error('Failed to fetch support codes:', err)
      setCodesError((err instanceof Error && err.message) || 'サポートコード一覧の取得に失敗しました')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  // ライセンス一覧を取得（ユーザー名も結合）
  const fetchLicenses = async () => {
    licensesAbortRef.current?.abort()
    const controller = new AbortController()
    licensesAbortRef.current = controller

    setLicensesLoading(true)
    setLicensesError(null)
    try {
      setLicenses(await adminApi.getLicenses({ signal: controller.signal }))
    } catch (err) {
      if (controller.signal.aborted) return
      console.error('Failed to fetch licenses:', err)
      setLicensesError((err instanceof Error && err.message) || 'ライセンス一覧の取得に失敗しました')
    } finally {
      if (!controller.signal.aborted) setLicensesLoading(false)
    }
  }

  const fetchTwitchSubs = async () => {
    twitchSubsAbortRef.current?.abort()
    const controller = new AbortController()
    twitchSubsAbortRef.current = controller

    setTwitchSubsLoading(true)
    setTwitchSubsError(null)
    try {
      const { rows, count } = await adminApi.getTwitchSubs({ signal: controller.signal })
      setTwitchSubs(rows)
      setTwitchSubCount(count)
    } catch (err) {
      if (controller.signal.aborted) return
      console.error('Failed to fetch twitch subs:', err)
      setTwitchSubsError((err instanceof Error && err.message) || 'Twitchサブスク一覧の取得に失敗しました')
    } finally {
      if (!controller.signal.aborted) setTwitchSubsLoading(false)
    }
  }

  useEffect(() => {
    fetchCodes()
    fetchLicenses()
    fetchTwitchSubs()
    return () => {
      codesAbortRef.current?.abort()
      licensesAbortRef.current?.abort()
      twitchSubsAbortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // SHA-256ハッシュを計算（Web Crypto API）
  const sha256 = async (text: string): Promise<string> => {
    const encoder = new TextEncoder()
    const data = encoder.encode(text)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // ランダムコードを生成（16バイト = 32文字の16進数）
  const generateRandomCode = (): string => {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // コード生成ハンドラ
  const handleGenerate = async () => {
    setGenerating(true)
    setCodesWriteError(null)
    try {
      const plainCode = generateRandomCode()
      const codeHash = await sha256(plainCode)

      await adminApi.createSupportCode({
        code_hash: codeHash,
        plan_type: newPlanType,
        memo: newMemo.trim() || null,
      })

      // 平文コードを一度だけ表示
      setGeneratedPlainCode(plainCode)
      setNewMemo('')
      fetchCodes()
    } catch (error) {
      console.error('Failed to generate code:', error)
      setCodesWriteError((error instanceof Error && error.message) || '支援コードの生成に失敗しました')
    } finally {
      setGenerating(false)
    }
  }

  // コードステータス変更
  const updateCodeStatus = async (codeId: string, newStatus: SupportCodeStatus) => {
    // 新しい書き込み操作の試行なので、前回の書き込みエラー表示は一旦クリアする
    setCodesWriteError(null)

    // revoke時はRPC経由で関連ライセンスも削除
    if (newStatus === 'revoked') {
      if (!confirm('Revoke this code? All associated licenses will be deleted.')) return
      try {
        await adminApi.revokeSupportCode(codeId)
        fetchCodes()
        fetchLicenses()
      } catch (error) {
        console.error('Failed to revoke code:', error)
        setCodesWriteError((error instanceof Error && error.message) || 'コードのrevokeに失敗しました')
      }
      return
    }

    try {
      await adminApi.updateSupportCodeStatus(codeId, newStatus)
      fetchCodes()
    } catch (error) {
      console.error('Failed to update code status:', error)
      setCodesWriteError((error instanceof Error && error.message) || 'コードステータスの更新に失敗しました')
    }
  }

  // コード一覧テーブル列定義
  const codeColumns = [
    {
      key: 'code_hash',
      header: 'Code Hash',
      render: (item: SupportCode) => (
        <span className="font-mono text-xs text-gray-600">{item.code_hash.slice(0, 16)}...</span>
      ),
    },
    {
      key: 'plan_type',
      header: 'Plan',
      render: (item: SupportCode) => {
        const plan = PLAN_OPTIONS.find(p => p.value === item.plan_type)
        return (
          <span className={`rounded-full px-2 py-1 text-xs font-medium ${plan?.color || 'bg-gray-100'}`}>
            {plan?.label || item.plan_type}
          </span>
        )
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (item: SupportCode) => {
        const status = STATUS_OPTIONS.find(s => s.value === item.status)
        return (
          <span className={`rounded-full px-2 py-1 text-xs font-medium ${status?.color || ''}`}>
            {status?.label || item.status}
          </span>
        )
      },
    },
    {
      key: 'activation_count',
      header: 'Activations',
      render: (item: SupportCode) => (
        <span className="text-gray-600">{item.activation_count}</span>
      ),
    },
    {
      key: 'memo',
      header: 'Memo',
      render: (item: SupportCode) => (
        <span className="max-w-xs truncate text-sm text-gray-500">{item.memo || '-'}</span>
      ),
    },
    {
      key: 'created_at',
      header: 'Created',
      render: (item: SupportCode) => (
        <span className="text-sm text-gray-500">
          {new Date(item.created_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (item: SupportCode) => (
        <div className="flex gap-1">
          {item.status === 'active' && (
            <button
              onClick={(e) => { e.stopPropagation(); updateCodeStatus(item.id, 'rotating') }}
              className="rounded bg-orange-500 px-2 py-1 text-xs text-white hover:bg-orange-600"
              title="Mark as rotating (still usable, but may be replaced soon)"
            >
              Rotate
            </button>
          )}
          {item.status !== 'revoked' && (
            <button
              onClick={(e) => { e.stopPropagation(); updateCodeStatus(item.id, 'revoked') }}
              className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
              title="Revoke code and delete all associated licenses"
            >
              Revoke
            </button>
          )}
        </div>
      ),
    },
  ]

  // ライセンス一覧テーブル列定義
  const licenseColumns = [
    {
      key: 'twitch_username',
      header: 'User',
      render: (item: LicenseWithUser) => (
        <span className="font-medium">{item.twitch_username}</span>
      ),
    },
    {
      key: 'plan_type',
      header: 'Plan',
      render: (item: LicenseWithUser) => {
        const plan = PLAN_OPTIONS.find(p => p.value === item.plan_type)
        return (
          <span className={`rounded-full px-2 py-1 text-xs font-medium ${plan?.color || 'bg-gray-100'}`}>
            {plan?.label || item.plan_type}
          </span>
        )
      },
    },
    {
      key: 'fanbox_id',
      header: 'FANBOX ID',
      render: (item: LicenseWithUser) => (
        <span className="text-sm text-gray-500">{item.fanbox_id || '-'}</span>
      ),
    },
    {
      key: 'activated_at',
      header: 'Activated',
      render: (item: LicenseWithUser) => (
        <span className="text-sm text-gray-500">
          {new Date(item.activated_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'code_id',
      header: 'Code ID',
      render: (item: LicenseWithUser) => (
        <span className="font-mono text-xs text-gray-400">{item.code_id.slice(0, 8)}...</span>
      ),
    },
  ]

  // 統計サマリー
  const activeCodesCount = codes.filter(c => c.status === 'active').length
  const totalActivations = codes.reduce((sum, c) => sum + c.activation_count, 0)
  // プランタイプ別ライセンス数
  const supportLicenses = licenses.filter(l => l.plan_type === 'support').length
  const patronLicenses = licenses.filter(l => l.plan_type === 'patron').length

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Licenses</h1>
        <p className="text-sm text-gray-500 mt-1">Manage support codes and user licenses</p>
      </div>

      {/* 統計サマリー */}
      <div className="mb-6 grid grid-cols-3 gap-4 sm:grid-cols-7">
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Total Codes</p>
          <p className="text-2xl font-bold">{codes.length}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Active Codes</p>
          <p className="text-2xl font-bold text-green-600">{activeCodesCount}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Total Activations</p>
          <p className="text-2xl font-bold text-blue-600">{totalActivations}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Active Licenses</p>
          <p className="text-2xl font-bold text-purple-600">{licenses.length}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Supporter</p>
          <p className="text-2xl font-bold text-blue-600">{supportLicenses}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Patron</p>
          <p className="text-2xl font-bold text-yellow-600">{patronLicenses}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Twitch Sub</p>
          <p className="text-2xl font-bold text-purple-500">{twitchSubCount}</p>
        </div>
      </div>

      {/* タブ切り替え */}
      <div className="mb-4 flex border-b">
        <button
          onClick={() => setActiveTab('codes')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            activeTab === 'codes'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Support Codes
        </button>
        <button
          onClick={() => setActiveTab('licenses')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            activeTab === 'licenses'
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          User Licenses ({licenses.length})
        </button>
        <button
          onClick={() => setActiveTab('twitch_subs')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${
            activeTab === 'twitch_subs'
              ? 'border-purple-500 text-purple-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Twitch Subs ({twitchSubCount})
        </button>
      </div>

      {/* コードタブ */}
      {activeTab === 'codes' && (
        <>
          <div className="space-y-2">
            <ErrorBanner messages={[codesError]} onRetry={() => fetchCodes()} />
            {/* 生成/revoke/ステータス変更失敗の通知。見出しを「書き込みエラー」にして
                読み取りエラーとの意味的な矛盾を避ける。書き込み操作は再送信ボタンではなく
                ユーザーが再度フォーム/ボタン操作すればよいのでonRetryは付けない */}
            <ErrorBanner messages={[codesWriteError]} title="書き込みエラー" />
          </div>

          {/* コード生成ボタン */}
          <div className="mb-4 flex justify-end">
            <button
              onClick={() => { setShowGenerateForm(true); setGeneratedPlainCode(null) }}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              + Generate Code
            </button>
          </div>

          {/* 生成された平文コードの表示（一度だけ） */}
          {generatedPlainCode && (
            <div className="mb-4 rounded-lg border-2 border-green-400 bg-green-50 p-4">
              <p className="mb-2 text-sm font-semibold text-green-800">
                Code generated successfully! Copy this code now - it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-white px-3 py-2 font-mono text-lg text-green-900 border">
                  {generatedPlainCode}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(generatedPlainCode)
                    alert('Code copied to clipboard')
                  }}
                  className="rounded bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700"
                >
                  Copy
                </button>
              </div>
              <button
                onClick={() => setGeneratedPlainCode(null)}
                className="mt-2 text-xs text-green-600 hover:underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* コード生成フォーム */}
          {showGenerateForm && !generatedPlainCode && (
            <div className="mb-4 rounded-lg bg-white p-6 shadow">
              <h2 className="mb-4 text-lg font-semibold">Generate New Support Code</h2>
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Plan Type</label>
                  <select
                    value={newPlanType}
                    onChange={e => setNewPlanType(e.target.value as PlanType)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    {PLAN_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Memo (optional)</label>
                  <input
                    type="text"
                    value={newMemo}
                    onChange={e => setNewMemo(e.target.value)}
                    placeholder="e.g., FANBOX 2026-02 batch"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {generating ? 'Generating...' : 'Generate'}
                  </button>
                  <button
                    onClick={() => setShowGenerateForm(false)}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* コード一覧テーブル */}
          <DataTable
            columns={codeColumns}
            data={codes}
            keyExtractor={(item) => item.id}
            loading={loading}
            emptyMessage="No support codes yet"
            pagination={{
              currentPage: codesPage,
              pageSize: codesPageSize,
              onPageChange: setCodesPage,
              onPageSizeChange: (size) => { setCodesPageSize(size); setCodesPage(1) },
              pageSizeOptions: [10, 20, 50],
            }}
          />
        </>
      )}

      {/* ライセンスタブ */}
      {activeTab === 'licenses' && (
        <>
          <ErrorBanner messages={[licensesError]} onRetry={() => fetchLicenses()} />
          <DataTable
            columns={licenseColumns}
            data={licenses}
            keyExtractor={(item) => item.id}
            loading={licensesLoading}
            emptyMessage="No active licenses"
            pagination={{
              currentPage: licensesPage,
              pageSize: licensesPageSize,
              onPageChange: setLicensesPage,
              onPageSizeChange: (size) => { setLicensesPageSize(size); setLicensesPage(1) },
              pageSizeOptions: [10, 20, 50],
            }}
          />
        </>
      )}

      {/* Twitchサブスクタブ */}
      {activeTab === 'twitch_subs' && (
        <>
          <ErrorBanner messages={[twitchSubsError]} onRetry={() => fetchTwitchSubs()} />
          <DataTable
            columns={[
              {
                key: 'twitch_display_name',
                header: 'User',
                render: (item: TwitchSubUser) => (
                  <span className="font-medium">{item.twitch_display_name || item.twitch_user_id}</span>
                ),
              },
              {
                key: 'twitch_user_id',
                header: 'Twitch ID',
                render: (item: TwitchSubUser) => (
                  <span className="font-mono text-xs text-gray-500">{item.twitch_user_id}</span>
                ),
              },
              {
                key: 'twitch_sub_verified_at',
                header: 'Verified At',
                render: (item: TwitchSubUser) => (
                  <span className="text-sm text-gray-500">
                    {item.twitch_sub_verified_at
                      ? new Date(item.twitch_sub_verified_at).toLocaleString()
                      : '-'}
                  </span>
                ),
              },
            ]}
            data={twitchSubs}
            keyExtractor={(item: TwitchSubUser) => item.twitch_user_id}
            loading={twitchSubsLoading}
            emptyMessage="No Twitch subscribers found"
            pagination={{
              currentPage: twitchSubsPage,
              pageSize: twitchSubsPageSize,
              onPageChange: setTwitchSubsPage,
              onPageSizeChange: (size) => { setTwitchSubsPageSize(size); setTwitchSubsPage(1) },
              pageSizeOptions: [10, 20, 50],
            }}
          />
        </>
      )}
    </div>
  )
}
