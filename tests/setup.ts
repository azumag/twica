import { vi } from 'vitest'
import '@testing-library/jest-dom'

// Setup environment variables
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
process.env.TWITCH_CLIENT_SECRET = 'test-client-secret'
process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID = 'test-client-id'
process.env.TWITCH_EVENTSUB_SECRET = 'test-eventsub-secret'
process.env.CSRF_SIGNING_KEY = 'test-csrf-signing-key'
process.env.CSRF_TOKEN_SALT = 'test-csrf-token-salt-at-least-32-characters-long'
process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-read-write-token'
process.env.CSRF_ALLOW_ALL_LOCAL = 'false'

// Mock clipboard API
Object.defineProperty(global.navigator, 'clipboard', {
  value: {
    writeText: vi.fn(),
  },
  writable: true,
})

// PlanetScale直結経路（postgres.js + Drizzle）のグローバル境界。
// DBアクセスを行う単体テストは、対象クエリの戻り値と呼び出し形状を明示した
// getDb fixture を必ず設定する。暗黙の空DBを返すと、必要な認可・所有権検証が
// 実行されたかを検出できず、実装回帰を成功扱いするため fail-fast にする。
//
// エクスポート形状は実モジュール（src/lib/db/client.ts）の実行時エクスポートと一致させる
// こと。#688 で normalizePgTimestampString / installIsoTimestampParsers が追加され、
// getDb 以外にも実行時エクスポートが増えた。この2つは DB 接続を持たない純関数
// （timestamp 文字列の正規化・postgres.js クライアントへのパーサ差し替え）なので、
// vi.importActual で実体を re-export し、getDb だけを throw スタブに差し替える。
// なお db-client 系テストは vi.unmock('@/lib/db/client') して実装本体を検証する。
vi.mock('@/lib/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/client')>()
  return {
    ...actual,
    getDb: vi.fn(() => {
      throw new Error(
        'getDb() requires an explicit PlanetScale/Drizzle fixture in this unit test. ' +
        'Override it with vi.mocked(getDb).mockResolvedValue(...).'
      )
    }),
  }
})
