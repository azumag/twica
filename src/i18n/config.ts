/**
 * i18n Configuration - Locale settings for the application
 * Supports Japanese (default) and English without URL-based routing.
 * Locale is determined by: 1) Cookie preference, 2) Browser Accept-Language header
 */

// Supported locales - Japanese is the default
// サポートするロケール - 日本語がデフォルト
export const locales = ['ja', 'en'] as const

// Default locale when none is detected
// 検出されない場合のデフォルトロケール
export const defaultLocale = 'ja' as const

// Type for supported locales
// サポートされるロケールの型
export type Locale = (typeof locales)[number]

// Cookie name for storing user's locale preference
// ユーザーのロケール設定を保存するCookie名
export const LOCALE_COOKIE_NAME = 'NEXT_LOCALE'

// Cookie max age in seconds (1 year)
// Cookieの有効期限（1年）
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60
