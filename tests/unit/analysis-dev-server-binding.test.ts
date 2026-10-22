import { describe, expect, it } from 'vitest'
import {
  ALLOW_EXTERNAL_KEY,
  ALLOW_EXTERNAL_VALUE,
  DEV_SERVER_PORT,
  resolveDevServerBinding,
  toServerOptions,
} from '../../analysis/dev/devServerBinding'

// Issue #1899: analysis の Vite dev server は管理API(/__admin)をホストし、
// Node 側で DASHBOARD_DATABASE_URL を使って DB へ接続する。既定で全
// インターフェースへ bind すると、同一 LAN の第三者が Vite 本体の既知脆弱性
// (GHSA-4w7w-66w2-5vf9 等) 経由で管理PCへ到達しうるため、既定は loopback とし
// 明示的なオプトインがある場合だけ外部公開する契約を固定する。

describe('analysis dev server の bind 解決 (#1899)', () => {
  it('環境変数が未設定なら loopback を既定にする', () => {
    const binding = resolveDevServerBinding({})
    expect(binding.host).toBe('127.0.0.1')
    expect(binding.external).toBe(false)
    expect(binding.warning).toBeNull()
  })

  it('空文字や空白のみの値でも loopback のままにする', () => {
    for (const raw of ['', '   ', '\t']) {
      const binding = resolveDevServerBinding({ [ALLOW_EXTERNAL_KEY]: raw })
      expect(binding.host, `raw=${JSON.stringify(raw)}`).toBe('127.0.0.1')
      expect(binding.external).toBe(false)
      expect(binding.warning).toBeNull()
    }
  })

  it("値が '1' のときだけ外部公開へ切り替える", () => {
    const binding = resolveDevServerBinding({ [ALLOW_EXTERNAL_KEY]: '1' })
    expect(binding.host).toBe('0.0.0.0')
    expect(binding.external).toBe(true)
    expect(binding.warning).toBeNull()
  })

  it("'1' 以外の真値っぽい値では公開せず、警告を返す（fail-closed）", () => {
    // 'true'/'yes'/'on' を許すと「設定したつもりがない値」で公開に倒れる余地が増える。
    for (const raw of ['true', 'TRUE', 'yes', 'on', '0', '2', 'enable']) {
      const binding = resolveDevServerBinding({ [ALLOW_EXTERNAL_KEY]: raw })
      expect(binding.host, `raw=${raw}`).toBe('127.0.0.1')
      expect(binding.external, `raw=${raw}`).toBe(false)
      // 「設定したのに効いていない」と誤解されると危険な回避策を招くため警告する。
      expect(binding.warning, `raw=${raw}`).not.toBeNull()
      expect(binding.warning).toContain(raw)
    }
  })

  it('前後の空白は無視して判定する', () => {
    const binding = resolveDevServerBinding({ [ALLOW_EXTERNAL_KEY]: '  1  ' })
    expect(binding.host).toBe('0.0.0.0')
    expect(binding.external).toBe(true)
  })

  it('クライアント露出を意味する VITE_ 接頭辞を使わない', () => {
    // Vite は envPrefix(VITE_) 付きの変数を import.meta.env へ露出する。
    // サーバー bind の意思決定に VITE_ を付けると誤用を招くため固定する。
    expect(ALLOW_EXTERNAL_KEY.startsWith('VITE_')).toBe(false)
    expect(ALLOW_EXTERNAL_VALUE).toBe('1')
  })
})

describe('toServerOptions は実際の Vite server 設定へ結線される (#1899)', () => {
  // このテスト群は「resolve した結果が Vite に渡る形になっているか」を固定する。
  // 純関数だけを検証していると、vite.config.ts 側を host: true に戻しても
  // 気づけないため、戻り値を server オプションへ写す層も対象にする。

  it('既定では 127.0.0.1 へ bind する', () => {
    const options = toServerOptions(resolveDevServerBinding({}))
    expect(options.host).toBe('127.0.0.1')
    expect(options.port).toBe(DEV_SERVER_PORT)
  })

  it('オプトイン時のみ 0.0.0.0 へ bind する', () => {
    const options = toServerOptions(
      resolveDevServerBinding({ [ALLOW_EXTERNAL_KEY]: '1' }),
    )
    expect(options.host).toBe('0.0.0.0')
  })

  it('allowedHosts を一切設定しない（DNS rebinding 対策のため）', () => {
    // Vite は IP リテラルと localhost を常に許可し、未知のホスト名だけを
    // allowedHosts で判定する。allowedHosts: true を渡すと Host 検証が
    // 丸ごと無効化され、攻撃者ドメインを LAN IP へ再解決する DNS rebinding が
    // 成立する。外部公開時も IP 直指定で足りるため常に未設定とする。
    for (const env of [{}, { [ALLOW_EXTERNAL_KEY]: '1' }]) {
      const options = toServerOptions(resolveDevServerBinding(env))
      expect(options).not.toHaveProperty('allowedHosts')
      // true だけでなく、いかなる allowlist も暗黙に足さない。
      expect(Object.keys(options).sort()).toEqual(['host', 'port'])
    }
  })
})
