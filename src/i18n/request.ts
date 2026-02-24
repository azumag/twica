/**
 * Server-side locale detection for next-intl
 * Determines locale from: 1) Cookie, 2) Accept-Language header, 3) Default
 */
import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import { defaultLocale, locales, LOCALE_COOKIE_NAME, type Locale } from './config'

/**
 * Parse Accept-Language header to find the best matching locale
 * Accept-Languageヘッダーを解析して最適なロケールを見つける
 */
function getLocaleFromAcceptLanguage(acceptLanguage: string | null): Locale | null {
  if (!acceptLanguage) return null

  // Parse and sort by quality value (q parameter)
  // quality値（qパラメータ）で解析・ソート
  const languages = acceptLanguage
    .split(',')
    .map((lang) => {
      const [code, qValue] = lang.trim().split(';q=')
      return {
        code: code.split('-')[0].toLowerCase(), // Get base language code (e.g., 'en' from 'en-US')
        quality: qValue ? parseFloat(qValue) : 1,
      }
    })
    .sort((a, b) => b.quality - a.quality)

  // Find first matching locale
  // 最初に一致するロケールを探す
  for (const lang of languages) {
    if (locales.includes(lang.code as Locale)) {
      return lang.code as Locale
    }
  }

  return null
}

/**
 * Main request config for next-intl
 * next-intlのメインリクエスト設定
 */
export default getRequestConfig(async () => {
  // Priority 1: Check cookie for user's saved preference
  // 優先度1: ユーザーの保存された設定をCookieから確認
  const cookieStore = await cookies()
  const localeCookie = cookieStore.get(LOCALE_COOKIE_NAME)?.value

  if (localeCookie && locales.includes(localeCookie as Locale)) {
    return {
      locale: localeCookie as Locale,
      messages: (await import(`../../messages/${localeCookie}.json`)).default,
    }
  }

  // Priority 2: Check Accept-Language header
  // 優先度2: Accept-Languageヘッダーを確認
  const headerStore = await headers()
  const acceptLanguage = headerStore.get('accept-language')
  const browserLocale = getLocaleFromAcceptLanguage(acceptLanguage)

  if (browserLocale) {
    return {
      locale: browserLocale,
      messages: (await import(`../../messages/${browserLocale}.json`)).default,
    }
  }

  // Priority 3: Fall back to default locale
  // 優先度3: デフォルトロケールにフォールバック
  return {
    locale: defaultLocale,
    messages: (await import(`../../messages/${defaultLocale}.json`)).default,
  }
})
