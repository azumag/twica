import 'server-only'

import { logger as consoleLogger } from './logger'
import { logErrorFromLogger } from './sentry/error-handler'

/**
 * サーバー専用logger。
 *
 * Next.jsではClient Componentに`"use client"`が付くと、その全importがclient module
 * graphへ入る。共有loggerからDB永続化moduleをstatic/dynamic importすると、実行時の
 * `typeof window`判定より前にbundlerがpostgres.jsとNode.js組み込みmoduleを解決して
 * client buildを壊す。そのためconsole-only loggerとDB永続化を別entry pointへ分離し、
 * この側を`server-only`でcompile-timeに保護する。
 *
 * info/warn/errorのconsole出力は共有loggerへ委譲するため、機密情報マスキング・prefix・
 * テストのmock契約を重複実装しない。errorだけ、出力後にPlanetScaleのerrorsテーブルへ
 * fire-and-forgetで記録する。記録完了をレスポンス前に保証する必要がある経路は従来通り
 * `logErrorFromLogger()`を直接awaitすること。
 */
export const logger = {
  info: (message: string, ...args: unknown[]): void => {
    consoleLogger.info(message, ...args)
  },
  warn: (message: string, ...args: unknown[]): void => {
    consoleLogger.warn(message, ...args)
  },
  error: (message: string, ...args: unknown[]): void => {
    consoleLogger.error(message, ...args)
    // logErrorFromLoggerは内部で永続化失敗を捕捉し、呼び出し元へrejectを漏らさない。
    void logErrorFromLogger(message, args)
  },
}
