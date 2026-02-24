import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { DataTable } from '../components/DataTable'
import { Announcement } from '../types/database'

// お知らせの重要度ラベルと色
const SEVERITY_OPTIONS = [
  { value: 'info', label: 'Info', color: 'bg-blue-100 text-blue-800' },
  { value: 'warning', label: 'Warning', color: 'bg-yellow-100 text-yellow-800' },
  { value: 'critical', label: 'Critical', color: 'bg-red-100 text-red-800' },
] as const

// お知らせ + 既読数の拡張型
interface AnnouncementWithStats extends Announcement {
  read_count: number
}

// 既読レコードの型（selectクエリ結果用）
interface ReadRecord {
  announcement_id: string
}

// フォーム初期値
const INITIAL_FORM = {
  title: '',
  body: '',
  severity: 'info' as 'info' | 'warning' | 'critical',
  is_published: false,
  published_at: '',
  expires_at: '',
}

/**
 * お知らせ管理ページ（analysis管理ダッシュボード用）
 * お知らせの一覧表示、新規作成、編集、削除を行う
 *
 * Note: analysis SPA のDatabase型にはRelationshipsキーが未定義のため、
 * Supabase v2.91のwrite系メソッドで型エラーが発生する。
 * ランタイムでは問題ないため、write系クエリには型アサーションを使用する。
 */
export function Announcements() {
  const [announcements, setAnnouncements] = useState<AnnouncementWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  // フォーム表示制御
  const [showForm, setShowForm] = useState(false)
  // 編集中のお知らせID（nullなら新規作成モード）
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(INITIAL_FORM)
  const [saving, setSaving] = useState(false)

  // お知らせ一覧を取得
  const fetchAnnouncements = async () => {
    setLoading(true)
    try {
      // お知らせ一覧取得
      const { data: annData, error: annError } = await supabase
        .from('announcements')
        .select('*')
        .order('created_at', { ascending: false })

      if (annError) throw annError

      // 各お知らせの既読数を取得
      const { data: readCounts, error: readError } = await supabase
        .from('announcement_reads')
        .select('announcement_id')

      if (readError) throw readError

      // 既読数を集計
      const countMap = new Map<string, number>()
      ;((readCounts || []) as ReadRecord[]).forEach(r => {
        countMap.set(r.announcement_id, (countMap.get(r.announcement_id) || 0) + 1)
      })

      const withStats: AnnouncementWithStats[] = ((annData || []) as Announcement[]).map(a => ({
        ...a,
        read_count: countMap.get(a.id) || 0,
      }))

      setAnnouncements(withStats)
    } catch (error) {
      console.error('Failed to fetch announcements:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAnnouncements()
  }, [])

  // フォームリセット
  const resetForm = () => {
    setForm(INITIAL_FORM)
    setEditingId(null)
    setShowForm(false)
  }

  // 編集モードに切り替え
  const startEditing = (announcement: Announcement) => {
    setForm({
      title: announcement.title,
      body: announcement.body,
      severity: announcement.severity,
      is_published: announcement.is_published,
      published_at: announcement.published_at
        ? new Date(announcement.published_at).toISOString().slice(0, 16)
        : '',
      expires_at: announcement.expires_at
        ? new Date(announcement.expires_at).toISOString().slice(0, 16)
        : '',
    })
    setEditingId(announcement.id)
    setShowForm(true)
  }

  // 保存（新規作成 or 更新）
  const handleSave = async () => {
    if (!form.title.trim() || !form.body.trim()) return

    setSaving(true)
    try {
      const payload = {
        title: form.title.trim(),
        body: form.body.trim(),
        severity: form.severity,
        is_published: form.is_published,
        published_at: form.published_at ? new Date(form.published_at).toISOString() : null,
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
        updated_at: new Date().toISOString(),
      }

      if (editingId) {
        // 更新 - Database型にRelationshipsが未定義のため型アサーション使用
        const { error } = await (supabase
          .from('announcements') as any)
          .update(payload)
          .eq('id', editingId)
        if (error) throw error
      } else {
        // 新規作成
        const { error } = await (supabase
          .from('announcements') as any)
          .insert(payload)
        if (error) throw error
      }

      resetForm()
      fetchAnnouncements()
    } catch (error) {
      console.error('Failed to save announcement:', error)
      alert('Failed to save announcement')
    } finally {
      setSaving(false)
    }
  }

  // 削除
  const handleDelete = async (id: string) => {
    if (!confirm('Delete this announcement? This will also remove all read records.')) return

    try {
      const { error } = await (supabase
        .from('announcements') as any)
        .delete()
        .eq('id', id)
      if (error) throw error
      fetchAnnouncements()
    } catch (error) {
      console.error('Failed to delete announcement:', error)
      alert('Failed to delete announcement')
    }
  }

  // 公開/非公開トグル
  const togglePublish = async (announcement: AnnouncementWithStats) => {
    try {
      const { error } = await (supabase
        .from('announcements') as any)
        .update({
          is_published: !announcement.is_published,
          updated_at: new Date().toISOString(),
        })
        .eq('id', announcement.id)
      if (error) throw error
      fetchAnnouncements()
    } catch (error) {
      console.error('Failed to toggle publish:', error)
    }
  }

  // テーブル列定義
  const columns = [
    {
      key: 'title',
      header: 'Title',
      render: (item: AnnouncementWithStats) => (
        <div className="max-w-xs truncate font-medium">{item.title}</div>
      ),
    },
    {
      key: 'severity',
      header: 'Severity',
      render: (item: AnnouncementWithStats) => {
        const sev = SEVERITY_OPTIONS.find(s => s.value === item.severity)
        return (
          <span className={`rounded-full px-2 py-1 text-xs font-medium ${sev?.color || ''}`}>
            {sev?.label || item.severity}
          </span>
        )
      },
    },
    {
      key: 'is_published',
      header: 'Status',
      render: (item: AnnouncementWithStats) => (
        <button
          onClick={(e) => { e.stopPropagation(); togglePublish(item) }}
          className={`rounded-full px-2 py-1 text-xs font-medium ${
            item.is_published
              ? 'bg-green-100 text-green-800'
              : 'bg-gray-100 text-gray-600'
          }`}
        >
          {item.is_published ? 'Published' : 'Draft'}
        </button>
      ),
    },
    {
      key: 'read_count',
      header: 'Reads',
      render: (item: AnnouncementWithStats) => (
        <span className="text-gray-600">{item.read_count}</span>
      ),
    },
    {
      key: 'created_at',
      header: 'Created',
      render: (item: AnnouncementWithStats) => (
        <span className="text-sm text-gray-500">
          {new Date(item.created_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (item: AnnouncementWithStats) => (
        <div className="flex gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); startEditing(item) }}
            className="rounded bg-blue-500 px-3 py-1 text-xs text-white hover:bg-blue-600"
          >
            Edit
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete(item.id) }}
            className="rounded bg-red-500 px-3 py-1 text-xs text-white hover:bg-red-600"
          >
            Delete
          </button>
        </div>
      ),
    },
  ]

  // 統計サマリー
  const publishedCount = announcements.filter(a => a.is_published).length
  const totalReads = announcements.reduce((sum, a) => sum + a.read_count, 0)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
          <p className="text-sm text-gray-500 mt-1">Manage announcements displayed to users</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true) }}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          + New Announcement
        </button>
      </div>

      {/* 統計サマリー */}
      <div className="mb-6 grid grid-cols-3 gap-4">
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Total</p>
          <p className="text-2xl font-bold">{announcements.length}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Published</p>
          <p className="text-2xl font-bold text-green-600">{publishedCount}</p>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <p className="text-sm text-gray-500">Total Reads</p>
          <p className="text-2xl font-bold text-blue-600">{totalReads}</p>
        </div>
      </div>

      {/* 新規作成/編集フォーム */}
      {showForm && (
        <div className="mb-6 rounded-lg bg-white p-6 shadow">
          <h2 className="mb-4 text-lg font-semibold">
            {editingId ? 'Edit Announcement' : 'New Announcement'}
          </h2>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Title</label>
              <input
                type="text"
                value={form.title}
                onChange={e => setForm(prev => ({ ...prev, title: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="Announcement title"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Body</label>
              <textarea
                value={form.body}
                onChange={e => setForm(prev => ({ ...prev, body: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                rows={4}
                placeholder="Announcement body text"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Severity</label>
                <select
                  value={form.severity}
                  onChange={e => setForm(prev => ({ ...prev, severity: e.target.value as typeof form.severity }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  {SEVERITY_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.is_published}
                    onChange={e => setForm(prev => ({ ...prev, is_published: e.target.checked }))}
                    className="rounded"
                  />
                  Published
                </label>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Published At (optional)
                </label>
                <input
                  type="datetime-local"
                  value={form.published_at}
                  onChange={e => setForm(prev => ({ ...prev, published_at: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Expires At (optional)
                </label>
                <input
                  type="datetime-local"
                  value={form.expires_at}
                  onChange={e => setForm(prev => ({ ...prev, expires_at: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving || !form.title.trim() || !form.body.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
              </button>
              <button
                onClick={resetForm}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* お知らせ一覧テーブル */}
      <DataTable
        columns={columns}
        data={announcements}
        keyExtractor={(item) => item.id}
        loading={loading}
        emptyMessage="No announcements yet"
        pagination={{
          currentPage,
          pageSize,
          onPageChange: setCurrentPage,
          onPageSizeChange: (size) => { setPageSize(size); setCurrentPage(1) },
          pageSizeOptions: [10, 20, 50],
        }}
      />
    </div>
  )
}
