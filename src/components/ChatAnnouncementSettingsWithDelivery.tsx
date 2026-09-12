'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import ChatAnnouncementSettings from './ChatAnnouncementSettings'
import MultiDrawChatDeliverySettings from './MultiDrawChatDeliverySettings'

export default function ChatAnnouncementSettingsWithDelivery(
  props: React.ComponentProps<typeof ChatAnnouncementSettings>,
) {
  const t = useTranslations('multiDrawChatDelivery')
  const [showDeliverySettings, setShowDeliverySettings] = useState(false)

  return (
    <>
      <ChatAnnouncementSettings {...props} />
      <div className="mt-3 rounded-xl border border-white/5 bg-gray-900/30 p-3 sm:p-4">
        <button
          type="button"
          onClick={() => setShowDeliverySettings((value) => !value)}
          aria-expanded={showDeliverySettings}
          className="flex w-full items-center justify-between gap-3 text-left text-sm font-medium text-gray-200"
        >
          <span>{t('open')}</span>
          <span aria-hidden="true">{showDeliverySettings ? '−' : '+'}</span>
        </button>
        {showDeliverySettings && <MultiDrawChatDeliverySettings />}
      </div>
    </>
  )
}
