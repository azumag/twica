interface ErrorBannerProps {
  // 表示するエラーメッセージ。複数の独立したfetchが別々に失敗しうるページでは
  // 配列で渡して1つのバナーにまとめる（Gacha.tsx等の既存パターンを踏襲）。
  // null/undefined/falseは無視するので、条件式をそのまま並べて渡してよい
  messages: (string | null | undefined | false)[]
  // 指定時のみ再試行ボタンを表示する
  onRetry?: () => void
}

/**
 * データ取得エラー表示の共通コンポーネント（#701 UI state/UX統一）。
 * 以前は`console.error`のみでUIに何も表示されないページが大半だった問題と、
 * 表示していたページでも`role`/`aria-live`が無くスクリーンリーダーに
 * 通知されなかった問題の両方を解消する。
 */
export function ErrorBanner({ messages, onRetry }: ErrorBannerProps) {
  const visibleMessages = messages.filter((message): message is string => !!message)
  if (visibleMessages.length === 0) return null

  return (
    <div role="alert" aria-live="assertive" className="bg-red-50 border border-red-200 rounded-lg p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-red-800 font-medium">データの読み込みエラー</p>
          {visibleMessages.map((message, index) => (
            <p key={index} className="text-red-600 text-sm mt-1">
              {message}
            </p>
          ))}
          <p className="text-red-500 text-xs mt-2">詳細はブラウザのコンソールを確認してください。</p>
        </div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
          >
            再試行
          </button>
        )}
      </div>
    </div>
  )
}
