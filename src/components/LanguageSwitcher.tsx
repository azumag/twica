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
            {locale === 'ja' ? '日本語' : 'English'}
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
      {currentLocale === 'ja' ? 'English' : '日本語'}
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
          {locale === 'ja' ? '日本語' : 'English'}
        </button>
      ))}
    </div>
  )
}

/**
 * Language Switcher for settings page (larger, more visible buttons)
 * 設定ページ用の言語切り替え（大きく見やすいボタン）
 * PC表示時は横並びのカード形式、モバイルでは縦積みで表示
 */
export function LanguageSwitcherSettings() {
  const t = useTranslations('languageSwitcher')
  const currentLocale = useLocale()

  const switchLocale = (newLocale: Locale) => {
    if (newLocale === currentLocale) return
    document.cookie = `${LOCALE_COOKIE_NAME}=${newLocale};path=/;max-age=${LOCALE_COOKIE_MAX_AGE};samesite=lax`
    window.location.reload()
  }

  // Language options with full names and descriptions
  // 言語オプション（フルネームと説明付き）
  const languageOptions = [
    { locale: 'ja' as Locale, name: '日本語', nativeName: 'Japanese' },
    { locale: 'en' as Locale, name: 'English', nativeName: '英語' },
  ]

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
      {languageOptions.map((option) => {
        const isSelected = currentLocale === option.locale
        return (
          <button
            key={option.locale}
            onClick={() => switchLocale(option.locale)}
            className={`flex items-center gap-3 rounded-lg border-2 p-4 text-left transition-all sm:p-5 ${
              isSelected
                ? 'border-purple-500 bg-purple-600/20'
                : 'border-gray-600 bg-gray-700/50 hover:border-gray-500 hover:bg-gray-700'
            }`}
            aria-label={option.locale === 'ja' ? t('japanese') : t('english')}
          >
            {/* チェックマークアイコン（選択時のみ表示） */}
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
                isSelected
                  ? 'border-purple-500 bg-purple-500'
                  : 'border-gray-500'
              }`}
            >
              {isSelected && (
                <svg
                  className="h-4 w-4 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={3}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
            </div>
            {/* 言語名 */}
            <div>
              <div className={`text-base font-medium sm:text-lg ${isSelected ? 'text-white' : 'text-gray-200'}`}>
                {option.name}
              </div>
              <div className={`text-sm ${isSelected ? 'text-purple-300' : 'text-gray-400'}`}>
                {option.nativeName}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
