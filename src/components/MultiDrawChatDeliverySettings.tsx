'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE,
  DEFAULT_MULTI_DRAW_CHAT_DELIVERY_MODE,
  type MultiDrawChatDeliveryMode,
} from '@/lib/twitch/multi-draw-chat'

type SettingsResponse = {
  deliveryMode: MultiDrawChatDeliveryMode
  chunkSize: number
  intervalMs: number
}

const options: MultiDrawChatDeliveryMode[] = ['summary', 'individual', 'chunked']

export default function MultiDrawChatDeliverySettings() {
  const t = useTranslations('multiDrawChatDelivery')
  const [mode, setMode] = useState<MultiDrawChatDeliveryMode>(DEFAULT_MULTI_DRAW_CHAT_DELIVERY_MODE)
  const [chunkSize, setChunkSize] = useState(DEFAULT_MULTI_DRAW_CHAT_CHUNK_SIZE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)

  useEffect(() => {
    let active = true
    void fetch('/api/streamer/chat-multi-delivery', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GET settings failed: ${response.status}`)
        return response.json() as Promise<SettingsResponse>
      })
      .then((settings) => {
        if (!active) return
        setMode(settings.deliveryMode)
        setChunkSize(settings.chunkSize)
      })
      .catch(() => {
        if (!active) return
        setIsError(true)
        setMessage(t('loadError'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [t])

  const save = async () => {
    setSaving(true)
    setMessage(null)
    setIsError(false)
    try {
      const response = await fetch('/api/streamer/chat-multi-delivery', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveryMode: mode, chunkSize }),
      })
      if (!response.ok) throw new Error(`PUT settings failed: ${response.status}`)
      setMessage(t('saved'))
    } catch {
      setIsError(true)
      setMessage(t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="h-24 animate-pulse rounded-xl bg-white/5" aria-busy="true" />
  }

  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4 sm:p-5">
      <div className="mb-4">
        <h4 className="text-sm font-semibold text-white">{t('title')}</h4>
        <p className="mt-1 text-xs leading-5 text-gray-400">{t('description')}</p>
      </div>

      <fieldset className="space-y-2">
        {options.map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 hover:bg-white/[0.04]"
          >
            <input
              type="radio"
              name="multi-draw-chat-delivery-mode"
              value={option}
              checked={mode === option}
              onChange={() => setMode(option)}
              className="mt-1"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-gray-200">{t(option)}</span>
              <span className="mt-0.5 block text-xs leading-5 text-gray-500">
                {t(`${option}Description`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === 'chunked' && (
        <label className="mt-4 block text-sm text-gray-300">
          <span className="mb-1.5 block text-xs font-medium text-gray-400">{t('chunkSize')}</span>
          <select
            value={chunkSize}
            onChange={(event) => setChunkSize(Number(event.target.value))}
            className="w-full rounded-lg border border-white/10 bg-gray-950 px-3 py-2 text-sm text-gray-100 sm:w-48"
          >
            {[2, 3, 4, 5].map((count) => (
              <option key={count} value={count}>{t('cards', { count })}</option>
            ))}
          </select>
        </label>
      )}

      {mode !== 'summary' && (
        <p className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs leading-5 text-amber-100/80">
          {t('pacingNote')}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? t('saving') : t('save')}
        </button>
        {message && (
          <p className={`text-xs ${isError ? 'text-red-300' : 'text-emerald-300'}`} role={isError ? 'alert' : 'status'}>
            {message}
          </p>
        )}
      </div>
    </section>
  )
}
