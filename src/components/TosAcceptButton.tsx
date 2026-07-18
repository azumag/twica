'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { parseMaintenanceError } from '@/lib/maintenance/client'
import { useMaintenanceStatus } from './MaintenanceStatusProvider'

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
  const t = useTranslations('tosPage.accept')
  const tMaintenance = useTranslations('maintenance')
  // #694 Stage 6c: このコンポーネントは /tos ページ（dashboard/layout.tsx の外）で
  // 使われるため、MaintenanceStatusProviderは未設置。useMaintenanceStatus()は
  // Provider外では安全なデフォルト値({mode:'off'})を返す設計（フック側のコメント
  // 参照）なので事前disableは機能しないが、呼び出しても例外にはならず、実際の
  // 防御はguardWriteのサーバー側503→下のparseMaintenanceErrorによるエラー表示で
  // 担保される。
  const { mode: maintenanceMode } = useMaintenanceStatus()
  const isMaintenanceBlocked = maintenanceMode !== 'off'

  // 未ログインまたは同意済みの場合は何も表示しない
  // Don't show anything if not logged in or already accepted
  if (!isLoggedIn || hasAccepted) {
    return null
  }

  const handleAccept = async () => {
    // 事前disable(ボタン)をすり抜けた場合でも、fetch自体を発火させないための二重ガード。
    if (isMaintenanceBlocked) {
      setError(tMaintenance('writeDisabled'))
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/tos/accept', {
        method: 'POST',
      })

      const data = await response.json()

      if (!response.ok) {
        const maintenanceError = parseMaintenanceError(response, data)
        throw new Error(maintenanceError?.message || data.error || t('error'))
      }

      // 同意成功後、ダッシュボードへリダイレクト
      // After successful acceptance, redirect to dashboard
      router.push(data.redirectUrl || '/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('unexpectedError'))
      setIsLoading(false)
    }
  }

  return (
    <div className="mt-8 rounded-xl bg-purple-900/50 border border-purple-600 p-6">
      <h3 className="mb-3 text-lg font-semibold text-white">
        {t('title')}
      </h3>
      <p className="mb-4 text-gray-300">
        {t('description')}
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-900/50 border border-red-600 p-3 text-red-300">
          {error}
        </div>
      )}

      {isMaintenanceBlocked && (
        <p className="mb-4 text-sm text-yellow-400">{tMaintenance('writeDisabled')}</p>
      )}

      <button
        onClick={handleAccept}
        disabled={isLoading || isMaintenanceBlocked}
        title={isMaintenanceBlocked ? tMaintenance('writeDisabled') : undefined}
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
            {t('processing')}
          </>
        ) : (
          t('button')
        )}
      </button>
    </div>
  )
}
