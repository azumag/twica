'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { useMaintenanceStatus } from '@/components/MaintenanceStatusProvider'
import { parseMaintenanceError } from '@/lib/maintenance/client'

interface ChatDeliveryWarningProps {
  needsAttention: boolean
}

/**
 * ダッシュボード共通のチャット送信不能警告。
 *
 * 判定はserver layoutが行い、token/scope一覧はpropsへ渡さない。client側の責務は
 * 既存reauth APIを起動することだけに限定し、非dismissableにすることで、設定画面を
 * 開かない配信者にも「ガチャは継続するがチャットだけ届かない」状態を伝える。
 */
export default function ChatDeliveryWarning({ needsAttention }: ChatDeliveryWarningProps) {
  const t = useTranslations('chatDeliveryWarning')
  const tMaintenance = useTranslations('maintenance')
  const { mode: maintenanceMode } = useMaintenanceStatus()
  const isMaintenanceBlocked = maintenanceMode !== 'off'
  const [reauthorizing, setReauthorizing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!needsAttention) return null

  const handleReauthorize = async () => {
    // disabled属性だけに依存せず、テスト・支援技術・将来の呼び出し変更から直接
    // handlerが実行されてもmaintenance write境界を越えないよう二重にguardする。
    if (isMaintenanceBlocked) {
      setError(tMaintenance('writeDisabled'))
      return
    }
    setReauthorizing(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/reauth', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ additionalScopes: [ADDITIONAL_SCOPES.CHAT_WRITE] }),
      })
      const responseBody: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        // Contextのpoll間隔内にmaintenanceへ切り替わった競合でも、503の既存
        // structured contractだけを認識し、locale固定のmaintenance文言へ正規化する。
        // reauth endpointはDB障害でも503を返すため、statusだけでmaintenance扱い
        // すると原因を誤表示する。必ずmaintenance_* codeまで検証する。
        if (parseMaintenanceError(response, responseBody)) {
          setError(tMaintenance('writeDisabled'))
          setReauthorizing(false)
          return
        }
        throw new Error('reauth request failed')
      }
      const data = responseBody as {
        loginUrl?: unknown
        state?: unknown
      } | null
      if (typeof data?.loginUrl !== 'string') {
        throw new Error('reauth request failed')
      }

      // 既存ChatAnnouncementSettingsと同じOAuth state受け渡し。state値は認証用の
      // 一時値でtokenではなく、10分・Secure・SameSite=Laxに限定して保存する。
      if (typeof data.state === 'string') {
        document.cookie = `twitch_auth_state=${data.state}; path=/; max-age=600; secure; samesite=lax`
      }
      window.location.href = data.loginUrl
    } catch (reauthError) {
      // fetch実装やAPI内部の英語・機密寄りメッセージをUIへ露出せず、全未知失敗を
      // i18n済みの安全な文言へ正規化する。詳細はserver側ログで追跡する。
      void reauthError
      setError(t('reauthFailed'))
      setReauthorizing(false)
    }
  }

  return (
    <section
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="mb-4 rounded-xl border border-amber-500/50 bg-amber-950/60 px-4 py-4 text-amber-50 shadow-[inset_0_1px_0_rgba(251,191,36,0.08)]"
      data-testid="chat-delivery-warning"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold text-amber-200">{t('title')}</h2>
          <p className="mt-1 text-sm text-amber-100/90">{t('description')}</p>
          {isMaintenanceBlocked && (
            <p className="mt-2 text-sm text-yellow-300">{tMaintenance('writeDisabled')}</p>
          )}
          {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleReauthorize}
            disabled={reauthorizing || isMaintenanceBlocked}
            title={isMaintenanceBlocked ? tMaintenance('writeDisabled') : undefined}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 disabled:cursor-wait disabled:opacity-60"
          >
            {reauthorizing ? t('reauthorizing') : t('reauthorize')}
          </button>
          {/* full navigationでserver判定とsettings初期stateを確実に再生成する。同一
              settings page上から押した場合も既存client stateに阻まれずannouncementへ着く。 */}
          <a
            href="/dashboard/settings?section=announcement"
            className="text-sm font-medium text-amber-200 underline decoration-amber-400/60 underline-offset-4 hover:text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
          >
            {t('settingsLink')}
          </a>
        </div>
      </div>
    </section>
  )
}
