'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface TosAcceptButtonProps {
  // ユーザーがログイン済みかどうか
  // Whether the user is logged in
  isLoggedIn: boolean
  // ユーザーが既にTOSに同意済みかどうか
  // Whether the user has already accepted TOS
  hasAccepted: boolean
}

/**
 * 利用規約同意ボタンコンポーネント
 * Terms of Service acceptance button component
 * - ログインユーザーで未同意の場合のみ表示
 * - Only shown for logged-in users who haven't accepted
 */
export default function TosAcceptButton({ isLoggedIn, hasAccepted }: TosAcceptButtonProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 未ログインまたは同意済みの場合は何も表示しない
  // Don't show anything if not logged in or already accepted
  if (!isLoggedIn || hasAccepted) {
    return null
  }

  const handleAccept = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/tos/accept', {
        method: 'POST',
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || '同意の処理中にエラーが発生しました')
      }

      // 同意成功後、ダッシュボードへリダイレクト
      // After successful acceptance, redirect to dashboard
      router.push(data.redirectUrl || '/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : '予期しないエラーが発生しました')
      setIsLoading(false)
    }
  }

  return (
    <div className="mt-8 rounded-xl bg-purple-900/50 border border-purple-600 p-6">
      <h3 className="mb-3 text-lg font-semibold text-white">
        サービスをご利用いただくには
      </h3>
      <p className="mb-4 text-gray-300">
        TwiCaをご利用いただくには、上記の利用規約に同意していただく必要があります。
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/50 border border-red-600 p-3 text-red-300">
          {error}
        </div>
      )}

      <button
        onClick={handleAccept}
        disabled={isLoading}
        className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-6 py-3 font-medium text-white transition hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
          '利用規約に同意してサービスを利用する'
        )}
      </button>
    </div>
  )
}
