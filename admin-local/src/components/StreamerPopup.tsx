import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Streamer } from '../types/database'

interface StreamerPopupProps {
  streamer: Streamer | null | undefined
  children?: React.ReactNode
}

/**
 * StreamerPopup - クリックで小さなポップアップカードを表示するコンポーネント
 * ストリーマー名をクリックすると、プロフィール画像、名前、Twitchリンクを含む
 * 小さなカードがポップアップ表示される
 * ポータルを使用してbody直下にレンダリングし、親のoverflowに影響されない
 */
export function StreamerPopup({ streamer, children }: StreamerPopupProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  // クリック外で閉じる処理
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popupRef.current &&
        !popupRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // ポップアップの位置を計算（トリガー要素の位置に基づく）
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceRight = window.innerWidth - rect.left

      // 画面下部に近い場合は上に表示
      const showAbove = spaceBelow < 220

      // 画面右端に近い場合は左寄せ
      const alignRight = spaceRight < 280

      setPopupStyle({
        position: 'fixed',
        top: showAbove ? rect.top - 8 : rect.bottom + 8,
        left: alignRight ? rect.right - 256 : rect.left,
        transform: showAbove ? 'translateY(-100%)' : 'none',
        zIndex: 9999,
      })
    }
  }, [isOpen])

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setIsOpen(!isOpen)
  }

  // ストリーマー情報がない場合はchildrenまたはUnknownを表示
  // NOTE: フックの後に条件分岐を配置（Reactフックのルール遵守）
  if (!streamer) {
    return <span className="text-gray-400">{children || 'Unknown'}</span>
  }

  // ポップアップカードの内容
  const popupContent = (
    <div
      ref={popupRef}
      style={popupStyle}
      className="w-64 bg-white rounded-lg shadow-xl border border-gray-200 p-4"
      onClick={(e) => e.stopPropagation()}
    >
      {/* ヘッダー: プロフィール画像と名前 */}
      <div className="flex items-center space-x-3 mb-3">
        {streamer.twitch_profile_image_url ? (
          <img
            src={streamer.twitch_profile_image_url}
            alt={streamer.twitch_display_name}
            className="w-12 h-12 rounded-full"
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center">
            <span className="text-purple-600 text-lg">🎮</span>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 truncate">
            {streamer.twitch_display_name}
          </p>
          <p className="text-sm text-gray-500 truncate">
            @{streamer.twitch_username}
          </p>
        </div>
      </div>

      {/* ステータスバッジ */}
      <div className="flex items-center space-x-2 mb-3">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
            streamer.is_active
              ? 'bg-green-100 text-green-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {streamer.is_active ? 'Active' : 'Inactive'}
        </span>
        {streamer.channel_point_reward_id && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
            EventSub
          </span>
        )}
      </div>

      {/* Twitchリンクボタン */}
      <a
        href={`https://twitch.tv/${streamer.twitch_username}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
      >
        <span>Twitchで見る</span>
        <span className="ml-1">↗</span>
      </a>
    </div>
  )

  return (
    <>
      {/* トリガー: クリックでポップアップを開閉 */}
      <button
        ref={triggerRef}
        onClick={handleClick}
        type="button"
        className="text-left hover:text-purple-600 transition-colors cursor-pointer"
      >
        {children || (
          <span className="font-medium">{streamer.twitch_display_name}</span>
        )}
      </button>

      {/* ポップアップをポータルでbody直下にレンダリング */}
      {isOpen && createPortal(popupContent, document.body)}
    </>
  )
}
