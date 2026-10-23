/**
 * analysis ダッシュボードのローカル管理API(/__admin)の CSRF / DNS リバインディング対策。
 *
 * 回帰テストの対象: 以前は「接続元がループバックか」だけを見ており、開発者のブラウザ
 * から（=ループバックから）送られる、悪意あるWebページ由来のクロスサイト書き込みや
 * DNS リバインディングで、本番DBへ直結した /__admin の読み書きが成立していた。
 * 修正後は Host / Origin / Content-Type / 起動ごとのトークンヘッダを全て要求する。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_TOKEN_HEADER,
  ADMIN_TOKEN_META_NAME,
  checkAdminRequestGuard,
  generateAdminToken,
  localAdminApiPlugin,
} from '../../analysis/dev/localAdminApi'
import { adminAuthHeaders } from '../../analysis/src/lib/adminApi'

const TOKEN = 'a'.repeat(64)
const PORT = 5173

function makeReq(overrides: {
  method?: string
  headers?: Record<string, string | string[] | undefined>
}) {
  return {
    method: overrides.method ?? 'GET',
    headers: {
      host: `localhost:${PORT}`,
      [ADMIN_TOKEN_HEADER]: TOKEN,
      ...(overrides.method && overrides.method !== 'GET'
        ? { 'content-type': 'application/json' }
        : {}),
      ...overrides.headers,
    },
  } as never
}

describe('checkAdminRequestGuard', () => {
  it('正規のブラウザ(同一オリジン・トークン付き)のリクエストは通す', () => {
    expect(checkAdminRequestGuard(makeReq({}), { token: TOKEN, port: PORT })).toEqual({ ok: true })
    expect(
      checkAdminRequestGuard(
        makeReq({
          method: 'POST',
          headers: { origin: `http://localhost:${PORT}`, 'content-type': 'application/json; charset=utf-8' },
        }),
        { token: TOKEN, port: PORT }
      )
    ).toEqual({ ok: true })
  })

  it.each([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`])(
    'Host=%s を許可し、Origin もその Host と一致すれば通す',
    (host) => {
      const result = checkAdminRequestGuard(
        makeReq({ headers: { host, origin: `http://${host}` } }),
        { token: TOKEN, port: PORT }
      )
      expect(result).toEqual({ ok: true })
    }
  )

  it.each([
    ['攻撃者ドメイン(DNSリバインディング)', 'evil.example:5173'],
    ['攻撃者ドメイン(ポート違い)', 'evil.example'],
    ['別ポートのlocalhost', 'localhost:8080'],
    ['ポート無し', 'localhost'],
    ['LANアドレス', '192.168.0.10:5173'],
    ['サブドメインを装う', 'localhost.evil.example:5173'],
    ['末尾ドット', 'localhost.:5173'],
  ])('Host が %s の場合は拒否する', (_label, host) => {
    const result = checkAdminRequestGuard(makeReq({ headers: { host } }), { token: TOKEN, port: PORT })
    expect(result.ok).toBe(false)
  })

  it('Host ヘッダが無い場合は拒否する', () => {
    expect(
      checkAdminRequestGuard(makeReq({ headers: { host: undefined } }), { token: TOKEN, port: PORT }).ok
    ).toBe(false)
  })

  it('待受ポートが不明な場合は fail closed', () => {
    expect(checkAdminRequestGuard(makeReq({}), { token: TOKEN, port: undefined }).ok).toBe(false)
  })

  it.each([
    ['別オリジン', 'http://evil.example'],
    ['別ポートの localhost', 'http://localhost:3000'],
    ['null オリジン', 'null'],
    ['https', `https://localhost:${PORT}`],
  ])('Origin が %s の場合は拒否する', (_label, origin) => {
    const result = checkAdminRequestGuard(makeReq({ headers: { origin } }), { token: TOKEN, port: PORT })
    expect(result.ok).toBe(false)
  })

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
    '%s は Content-Type: application/json 以外を拒否する(フォーム/text/plain の単純リクエスト対策)',
    (method) => {
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', undefined]) {
        const result = checkAdminRequestGuard(
          makeReq({ method, headers: { 'content-type': contentType } }),
          { token: TOKEN, port: PORT }
        )
        expect(result.ok).toBe(false)
      }
    }
  )

  it.each([
    ['ヘッダ無し', undefined],
    ['空', ''],
    ['別のトークン', 'b'.repeat(64)],
    ['短いトークン', 'a'.repeat(63)],
    ['長いトークン', 'a'.repeat(65)],
    ['重複ヘッダ(配列)', [TOKEN, TOKEN]],
  ])('トークンが %s の場合は拒否する(GET でも)', (_label, token) => {
    const result = checkAdminRequestGuard(
      makeReq({ headers: { [ADMIN_TOKEN_HEADER]: token as string | undefined } }),
      { token: TOKEN, port: PORT }
    )
    expect(result.ok).toBe(false)
  })
})

describe('localAdminApiPlugin: トークンの配布とミドルウェア', () => {
  function setup() {
    const plugin = localAdminApiPlugin({ DASHBOARD_DATABASE_URL: 'postgres://fake-host/fake-db' }) as any
    const server: any = {
      middlewares: { use: vi.fn() },
      config: { server: { port: PORT } },
    }
    plugin.configureServer(server)
    const handler = server.middlewares.use.mock.calls[0][1] as (req: unknown, res: unknown) => Promise<void>
    const tags = plugin.transformIndexHtml('<html></html>', { server }) as Array<{
      attrs: { name: string; content: string }
      injectTo: string
    }>
    return { plugin, server, handler, token: tags[0].attrs.content, tags }
  }

  function call(handler: (req: unknown, res: unknown) => Promise<void>, req: Record<string, unknown>) {
    const res: any = { setHeader: vi.fn(), end: vi.fn() }
    return handler({ socket: { remoteAddress: '127.0.0.1' }, ...req }, res).then(() => res)
  }

  it('dev サーバー(ctx.server あり)の index.html にだけ meta でトークンを埋め込む', () => {
    const { plugin, tags, token } = setup()
    expect(tags).toHaveLength(1)
    expect(tags[0].attrs.name).toBe(ADMIN_TOKEN_META_NAME)
    expect(tags[0].injectTo).toBe('head')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    // vite build(ctx.server 無し)の成果物にはトークンを含めない
    expect(plugin.transformIndexHtml('<html></html>', {})).toBeUndefined()
  })

  it('トークンは起動(プラグイン生成)ごとに異なり、推測できない', () => {
    expect(setup().token).not.toBe(setup().token)
    expect(generateAdminToken()).not.toBe(generateAdminToken())
  })

  it('トークン無しの GET は 403 で DB 処理(ルーティング)に到達しない', async () => {
    const { handler } = setup()
    const res = await call(handler, { method: 'GET', url: '/overview', headers: { host: `localhost:${PORT}` } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.end.mock.calls[0][0]).error).toContain('Forbidden')
  })

  it('トークン付きでも Host が攻撃者ドメインなら 403(DNSリバインディング)', async () => {
    const { handler, token } = setup()
    const res = await call(handler, {
      method: 'GET',
      url: '/overview',
      headers: { host: 'evil.example:5173', [ADMIN_TOKEN_HEADER]: token },
    })
    expect(res.statusCode).toBe(403)
  })

  it('トークン付きでもクロスオリジンの Origin なら 403(CSRF)', async () => {
    const { handler, token } = setup()
    const res = await call(handler, {
      method: 'GET',
      url: '/overview',
      headers: { host: `localhost:${PORT}`, origin: 'http://evil.example', [ADMIN_TOKEN_HEADER]: token },
    })
    expect(res.statusCode).toBe(403)
  })

  it('書き込み(POST)は Content-Type: text/plain なら 403、トークン無しでも 403(本文は読まれない)', async () => {
    const { handler, token } = setup()
    // readBody は req を async iterate する。ガードより前に読まれていないことを iterator の
    // 呼び出し有無で確認する。
    const iterator = vi.fn()
    const base = { method: 'POST', url: '/announcements', [Symbol.asyncIterator]: iterator }

    const textPlain = await call(handler, {
      ...base,
      headers: { host: `localhost:${PORT}`, 'content-type': 'text/plain', [ADMIN_TOKEN_HEADER]: token },
    })
    expect(textPlain.statusCode).toBe(403)

    const noToken = await call(handler, {
      ...base,
      headers: { host: `localhost:${PORT}`, 'content-type': 'application/json' },
    })
    expect(noToken.statusCode).toBe(403)
    expect(iterator).not.toHaveBeenCalled()
  })

  it('正規のリクエスト(Host・トークン一致)はガードを通過してルーティングされる', async () => {
    const { handler, token } = setup()
    const res = await call(handler, {
      method: 'GET',
      url: '/no-such-route',
      headers: { host: `localhost:${PORT}`, [ADMIN_TOKEN_HEADER]: token },
    })
    // ガード通過後の 404(ルート無し)であり、403 ではない
    expect(res.statusCode).toBe(404)
  })

  it('実際の待受ポートが設定値と違う場合は listen 結果のポートで Host を検証する', async () => {
    const { plugin } = setup()
    const server: any = {
      middlewares: { use: vi.fn() },
      config: { server: { port: PORT } },
      httpServer: { address: () => ({ port: 5174 }) }, // 5173 使用中で自動的にずれた状態
    }
    plugin.configureServer(server)
    const handler = server.middlewares.use.mock.calls[0][1]

    const tags = plugin.transformIndexHtml('<html></html>', { server })
    const ownToken = tags[0].attrs.content

    const ok = await call(handler, {
      method: 'GET',
      url: '/no-such-route',
      headers: { host: 'localhost:5174', [ADMIN_TOKEN_HEADER]: ownToken },
    })
    expect(ok.statusCode).toBe(404)
    const stale = await call(handler, {
      method: 'GET',
      url: '/no-such-route',
      headers: { host: 'localhost:5173', [ADMIN_TOKEN_HEADER]: ownToken },
    })
    expect(stale.statusCode).toBe(403)
  })
})

describe('analysis クライアント: トークンの付与', () => {
  afterEach(() => {
    document.head.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('meta のトークンを X-Admin-Token ヘッダとして /__admin へ送る', async () => {
    document.head.innerHTML = `<meta name="${ADMIN_TOKEN_META_NAME}" content="${TOKEN}">`
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const { adminApi } = await import('../../analysis/src/lib/adminApi')
    await adminApi.getOverview()

    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(fetchMock.mock.calls[0][0]).toBe('/__admin/overview')
    expect((init.headers as Record<string, string>)[ADMIN_TOKEN_HEADER]).toBe(TOKEN)
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('CSV エクスポート用に同じヘッダを返す', () => {
    document.head.innerHTML = `<meta name="${ADMIN_TOKEN_META_NAME}" content="${TOKEN}">`
    expect(adminAuthHeaders()).toEqual({ [ADMIN_TOKEN_HEADER]: TOKEN })
  })

  it('meta が無い場合(本番ビルド等)はヘッダを付けない', () => {
    expect(adminAuthHeaders()).toEqual({})
  })
})

describe('analysis/vite.config.ts', () => {
  // vite.config.ts は analysis 側の依存(@vitejs/plugin-react 等)を import するため、
  // analysis の node_modules が無い root の typecheck/CI で読み込めない。設定値はソースの
  // テキストで検証する（コメント行は除外して実際の設定だけを見る）。
  const source = readFileSync(resolve(__dirname, '../../analysis/vite.config.ts'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

  it('dev サーバーはループバックのみで待ち受け(LAN公開しない)', () => {
    expect(source).toMatch(/host:\s*'127\.0\.0\.1'/)
    expect(source).not.toMatch(/host:\s*true/)
    expect(source).not.toMatch(/0\.0\.0\.0/)
  })

  it('CORS を許可しない(他オリジンが index.html のトークンを読めないように)', () => {
    expect(source).toMatch(/cors:\s*false/)
  })
})
