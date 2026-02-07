'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { VOTE_CAMPAIGN_DISMISS_KEY } from '@/lib/constants'

interface VoteCampaignButtonProps {
  // サーバー側で判定された「キャンペーン期間内かつ未適用」フラグ
  visible: boolean
  // ボーナス容量（MB）。サーバー側のVOTE_CAMPAIGN_CONFIG.BONUS_MBから渡す
  bonusMb: number
}

/**
 * 「投票行ったよ」キャンペーンボタン
 * 期間限定・1回限り。クリックで+5MBのストレージ容量ボーナスを付与
 * ユーザーは「今後表示しない」でlocalStorageに非表示設定を保存可能
 */
export default function VoteCampaignButton({ visible, bonusMb }: VoteCampaignButtonProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // localStorageの読み取り完了前はnull（ハイドレーション不一致を防ぐ）
  const [dismissed, setDismissed] = useState<boolean | null>(null)
  // 「今後表示しない」クリック後に案内メッセージを表示するフラグ
  const [showDismissMessage, setShowDismissMessage] = useState(false)

  useEffect(() => {
    setDismissed(localStorage.getItem(VOTE_CAMPAIGN_DISMISS_KEY) === 'true')
  }, [])

  // visible=false（期間外or適用済み）で未クリックの場合は非表示
  // applied=true（クリック後）の場合は成功メッセージ表示のため通過させる
  if (!visible && !applied) return null

  // localStorageの読み取り完了前は何も表示しない（ちらつき防止）
  if (dismissed === null) return null

  // ユーザーが「今後表示しない」を選択済みの場合は非表示
  // （applied=trueの場合は成功メッセージを優先表示）
  if (dismissed && !applied) {
    // dismiss直後の案内メッセージ表示中の場合
    if (showDismissMessage) {
      return (
        <div className="mb-8 rounded-xl bg-gray-800/50 border border-gray-600/50 p-4">
          <p className="text-sm text-gray-300">
            キャンペーンパネルを非表示にしました。再表示したい場合は、右上の歯車アイコン（ユーザ設定ページ）から設定できます。
          </p>
        </div>
      )
    }
    return null
  }

  const handleClick = async () => {
    setIsLoading(true)
    setError(null)

    try {
      // CSRF保護はサーバー側でHttpOnly Cookieから直接トークンを読み取るため、
      // クライアントからのX-CSRF-Tokenヘッダー送信は不要（credentials: 'include'でCookieが送信される）
      const response = await fetch('/api/storage-bonus/vote-campaign', {
        method: 'POST',
        credentials: 'include',
      })

      if (response.ok) {
        setApplied(true)
        router.refresh()
      } else if (response.status === 409) {
        // 既に適用済み（別タブで適用された場合等）→ ボタンを非表示に
        setApplied(true)
      } else {
        try {
          const data = await response.json()
          setError(data.error || 'エラーが発生しました')
        } catch {
          setError('エラーが発生しました')
        }
      }
    } catch {
      setError('ネットワークエラーが発生しました')
    } finally {
      setIsLoading(false)
    }
  }

  const handleDismiss = () => {
    localStorage.setItem(VOTE_CAMPAIGN_DISMISS_KEY, 'true')
    setDismissed(true)
    setShowDismissMessage(true)
  }

  // 適用済みの場合は成功メッセージを表示
  if (applied) {
    return (
      <div className="mb-8 rounded-xl bg-gradient-to-r from-green-900/50 to-emerald-900/50 border border-green-600/50 p-6">
        <p className="text-sm font-medium text-green-300">
          +{bonusMb}MB のストレージボーナスが適用されました！
        </p>
      </div>
    )
  }

  return (
    <div className="mb-8 rounded-xl bg-gradient-to-r from-pink-900/50 to-purple-900/50 border border-pink-600/50 p-6">
      <h3 className="mb-2 text-lg font-semibold text-white">
        選挙行ったよ/行こうかな キャンペーン
      </h3>
      <p className="mb-3 text-sm text-gray-300">
        ボタンを押すと画像アップロード容量が +{bonusMb}MB されます（1回限り）<br />
        ※ 将来アフィリエイト・パートナーになった際にも恩恵を受けられます
      </p>

      {error && (
        <div className="mb-3 rounded-lg bg-red-900/50 border border-red-600 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <button
        onClick={handleClick}
        disabled={isLoading}
        className="inline-flex items-center gap-2 rounded-lg bg-pink-600 px-6 py-3 font-medium text-white transition hover:bg-pink-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? (
          <>
            <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            処理中...
          </>
        ) : (
          '選挙行ったよ/行こうかな'
        )}
      </button>

      <div className="mt-4 space-y-2 text-xs text-gray-400 leading-relaxed">
        <p>
          ＊ 投票済証の提示など証拠を求めることはありません。自己申告です。また、現在選挙権のない方でも、将来得ることがあれば投票行こうかな、と思って頂ければ、どなたでもOKです。
        </p>
        <p>
          ＊ 本応援は、投票率が上がって欲しいな、という思いで開催しております。特定の政党や候補者を応援するものではありません。
        </p>
      </div>

      {/* 今後表示しないリンク */}
      <div className="mt-3 border-t border-gray-700/50 pt-3">
        <button
          onClick={handleDismiss}
          className="text-xs text-gray-500 underline hover:text-gray-400 transition"
        >
          今後表示しない
        </button>
      </div>
    </div>
  )
}
