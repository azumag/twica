'use client'

import { useTranslations, useLocale } from 'next-intl'
import { locales, LOCALE_COOKIE_NAME, LOCALE_COOKIE_MAX_AGE, type Locale } from '@/i18n/config'

/**
 * Language Switcher Component
 * Allows users to switch between Japanese and English.
 * Saves preference to cookie and reloads the page.
 * 言語切り替えコンポーネント - 日本語と英語を切り替え可能
 * 設定をCookieに保存してページをリロード
 */
export function LanguageSwitcher() {
  const t = useTranslations('languageSwitcher')
  const currentLocale = useLocale()

  /**
   * Switch to a different locale by setting cookie and reloading
   * Cookieを設定してリロードすることで別のロケールに切り替え
   */
  const switchLocale = (newLocale: Locale) => {
    if (newLocale === currentLocale) return

    // Set cookie with 1-year expiration
    // 1年の有効期限でCookieを設定
    document.cookie = `${LOCALE_COOKIE_NAME}=${newLocale};path=/;max-age=${LOCALE_COOKIE_MAX_AGE};samesite=lax`

    // Reload to apply the new locale
    // 新しいロケールを適用するためにリロード
    window.location.reload()
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-gray-500">{t('label')}:</span>
      <div className="flex rounded-md border border-gray-300 overflow-hidden">
        {locales.map((locale) => (
          <button
            key={locale}
            onClick={() => switchLocale(locale)}
            className={`px-3 py-1 text-sm transition-colors ${
              currentLocale === locale
                ? 'bg-purple-600 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
            aria-label={locale === 'ja' ? t('japanese') : t('english')}
          >
            {locale === 'ja' ? '日本語' : 'EN'}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Compact Language Switcher for mobile/small spaces
 * モバイル/狭いスペース用のコンパクトな言語切り替え
 */
export function LanguageSwitcherCompact() {
  const currentLocale = useLocale()

  const switchLocale = (newLocale: Locale) => {
    if (newLocale === currentLocale) return
    document.cookie = `${LOCALE_COOKIE_NAME}=${newLocale};path=/;max-age=${LOCALE_COOKIE_MAX_AGE};samesite=lax`
    window.location.reload()
  }

  // Toggle between locales
  // ロケールを切り替え
  const nextLocale: Locale = currentLocale === 'ja' ? 'en' : 'ja'

  return (
    <button
      onClick={() => switchLocale(nextLocale)}
      className="px-2 py-1 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
      aria-label={`Switch to ${nextLocale === 'ja' ? 'Japanese' : 'English'}`}
    >
      {currentLocale === 'ja' ? 'EN' : '日本語'}
    </button>
  )
}

/**
 * Language Switcher for dark theme (header use)
 * ダークテーマ用の言語切り替え（ヘッダー用）
 */
export function LanguageSwitcherDark() {
  const currentLocale = useLocale()

  const switchLocale = (newLocale: Locale) => {
    if (newLocale === currentLocale) return
    document.cookie = `${LOCALE_COOKIE_NAME}=${newLocale};path=/;max-age=${LOCALE_COOKIE_MAX_AGE};samesite=lax`
    window.location.reload()
  }

  return (
    <div className="flex rounded-md border border-gray-700 overflow-hidden">
      {locales.map((locale) => (
        <button
          key={locale}
          onClick={() => switchLocale(locale)}
          className={`px-3 py-1 text-sm transition-colors ${
            currentLocale === locale
              ? 'bg-purple-600 text-white'
              : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
          }`}
          aria-label={locale === 'ja' ? '日本語' : 'English'}
        >
          {locale === 'ja' ? '日本語' : 'EN'}
        </button>
      ))}
    </div>
  )
}
