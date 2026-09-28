import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom'

// React Testing Library (RTL) の DOM クリーンアップを setupFiles で明示登録する。
//
// RTL は import 時の副作用として `afterEach(cleanup)` を自動登録するが、
// node_modules の RTL は Vitest で外部化 (externalize) され Node のモジュール
// キャッシュに載るため、同一ワーカープロセス内では最初にそれを import した
// テストファイルでしか評価されない。`--poolOptions.forks.singleFork=true`
// (npm run test:agent) で全ファイルが1プロセスに載ると、2ファイル目以降は
// afterEach が登録されず、前のテストで render したツリーが document.body に
// 残って後続テストの `screen.queryByRole(...)` 等に混入する。実例:
// channel-points-access-section.test.tsx の Affiliate ケースが、直前のテストで
// 描画された「有効化ボタン」を拾って単独実行時のみ成功していた。
//
// setupFiles は `isolate` 下でテストファイルごとに再評価されるため、ここで登録すれば
// プール設定に依存せず毎ファイルで cleanup が走る（本対応の範囲は cleanup のみ。RTL が
// 同様に自動登録する IS_REACT_ACT_ENVIRONMENT の設定も2ファイル目以降で欠けるが、
// act 警告の有無が変わるだけでテスト結果には影響しない）。RTL 公式ドキュメントも
// 自動 cleanup が効かない環境では cleanup を手動で呼ぶよう案内している
// (https://testing-library.com/docs/react-testing-library/api#cleanup)。
// cleanup は描画済みコンテナの集合を空にするだけの冪等処理なので、自動登録が
// 効いている場合に二重実行されても無害。
afterEach(() => {
  cleanup()
})

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
