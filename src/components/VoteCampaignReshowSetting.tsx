'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { VOTE_CAMPAIGN_DISMISS_KEY } from '@/lib/constants'

interface VoteCampaignReshowSettingProps {
  // サーバー判定: キャンペーン期間内 AND 未適用（ボーナス未取得）
  // false = 適用済み or 期間外 → 再表示ボタン自体を出す必要なし
  visible: boolean
}

/**
 * 設定ページ用：キャンペーンパネル再表示ボタン
 * ユーザーが「今後表示しない」を選択した場合に、設定ページから再表示できる手段を提供する
 * 適用済みまたは期間外の場合はこのコンポーネント自体を表示しない
 */
export default function VoteCampaignReshowSetting({ visible }: VoteCampaignReshowSettingProps) {
  const router = useRouter()
  // localStorageの読み取り完了前はnull（ハイドレーション不一致を防ぐ）
  const [dismissed, setDismissed] = useState<boolean | null>(null)

  useEffect(() => {
    setDismissed(localStorage.getItem(VOTE_CAMPAIGN_DISMISS_KEY) === 'true')
  }, [])

  // 適用済み or 期間外 → 再表示設定自体が不要
  if (!visible) return null

  // localStorage読み取り前、または非表示設定がない場合は表示不要
  if (dismissed === null || !dismissed) return null

  const handleReshow = () => {
    localStorage.removeItem(VOTE_CAMPAIGN_DISMISS_KEY)
    setDismissed(false)
    // サーバーコンポーネントを再取得してVoteCampaignButtonを再表示させる
    router.refresh()
  }

  return (
    <div className="mb-6 rounded-lg bg-gray-800/50 border border-gray-600/50 p-4 flex items-center justify-between">
      <p className="text-sm text-gray-300">
        選挙キャンペーンパネルが非表示になっています
      </p>
      <button
        onClick={handleReshow}
        className="rounded-md bg-pink-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-pink-700"
      >
        再表示する
      </button>
    </div>
  )
}
