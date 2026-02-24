'use client'

import { Suspense, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'

function CallbackCompleteContent() {
  const searchParams = useSearchParams()

  useEffect(() => {
    // The session cookie has been set by the API route
    // Now redirect to the dashboard
    const redirectTo = searchParams.get('redirect') || '/dashboard'

    // Use window.location for a full page navigation to ensure cookies are sent
    window.location.href = redirectTo
  }, [searchParams])

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900">
      <div className="text-center">
        <div className="mb-4 text-white">ログイン完了</div>
        <div className="text-gray-400">リダイレクト中...</div>
      </div>
    </div>
  )
}

export default function CallbackCompletePage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-gray-900">
        <div className="text-center">
          <div className="mb-4 text-white">ログイン完了</div>
          <div className="text-gray-400">リダイレクト中...</div>
        </div>
      </div>
    }>
      <CallbackCompleteContent />
    </Suspense>
  )
}
