import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Streamer, Card } from '../types/database'
import { RarityBadge } from './RarityBadge'

interface StreamerPopupProps {
  streamer: Streamer | null | undefined
  // ストリーマーが登録しているカード一覧（オプション）
  // 渡された場合、ポップアップ内にカード一覧を表示する
  cards?: Card[]
  children?: React.ReactNode
}

/**
 * StreamerPopup - クリックで小さなポップアップカードを表示するコンポーネント
 * ストリーマー名をクリックすると、プロフィール画像、名前、Twitchリンクを含む
 * 小さなカードがポップアップ表示される
 * cardsが渡された場合、ストリーマーが登録しているカード一覧も表示する
 * ポータルを使用してbody直下にレンダリングし、親のoverflowに影響されない
 */
export function StreamerPopup({ streamer, cards, children }: StreamerPopupProps) {
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
  // cardsが渡されている場合はポップアップが大きくなるため、必要スペースを増やす
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceRight = window.innerWidth - rect.left

      // カード一覧がある場合は必要な縦スペースが増える
      // 基本高さ(約200px) + カード一覧(最大160px) + バッファ
      const requiredHeight = cards && cards.length > 0 ? 400 : 220

      // 画面下部に近い場合は上に表示
      const showAbove = spaceBelow < requiredHeight

      // ポップアップ幅: カードがある場合は広め(320px)、ない場合は標準(256px)
      const popupWidth = cards && cards.length > 0 ? 320 : 256

      // 画面右端に近い場合は左寄せ
      const alignRight = spaceRight < popupWidth + 20

      setPopupStyle({
        position: 'fixed',
        top: showAbove ? rect.top - 8 : rect.bottom + 8,
        left: alignRight ? rect.right - popupWidth : rect.left,
        transform: showAbove ? 'translateY(-100%)' : 'none',
        zIndex: 9999,
      })
    }
  }, [isOpen, cards])

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
  // カードがある場合は幅を広げて表示領域を確保
  const popupWidthClass = cards && cards.length > 0 ? 'w-80' : 'w-64'

  const popupContent = (
    <div
      ref={popupRef}
      style={popupStyle}
      className={`${popupWidthClass} bg-white rounded-lg shadow-xl border border-gray-200 p-4`}
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

      {/* カード一覧セクション（cardsが渡された場合のみ表示） */}
      {cards && cards.length > 0 && (
        <div className="mb-3">
          <p className="text-xs font-medium text-gray-500 mb-2">
            登録カード ({cards.length}枚)
          </p>
          {/* カード一覧をスクロール可能なリストで表示 */}
          <div className="max-h-40 overflow-y-auto space-y-2">
            {cards.map((card) => (
              <div
                key={card.id}
                className="flex items-center space-x-2 p-2 bg-gray-50 rounded-lg"
              >
                {/* カード画像（あれば表示、なければプレースホルダー） */}
                {card.image_url ? (
                  <img
                    src={card.image_url}
                    alt={card.name}
                    className="w-10 h-10 rounded object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded bg-gray-200 flex items-center justify-center flex-shrink-0">
                    <span className="text-gray-400 text-xs">🃏</span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  {/* カード名（長い場合は省略） */}
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {card.name}
                  </p>
                  {/* レアリティバッジとステータス */}
                  <div className="flex items-center space-x-1 mt-0.5">
                    <RarityBadge rarity={card.rarity} />
                    {/* ステータス表示（HP/ATK/DEF/SPD） */}
                    <span className="text-xs text-gray-400">
                      HP:{card.hp} ATK:{card.atk}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* カードが0件の場合のメッセージ */}
      {cards && cards.length === 0 && (
        <div className="mb-3 p-2 bg-gray-50 rounded-lg">
          <p className="text-xs text-gray-400 text-center">
            カードが登録されていません
          </p>
        </div>
      )}

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
