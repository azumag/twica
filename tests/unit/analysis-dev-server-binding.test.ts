import { describe, expect, it } from 'vitest'
import {
  ALLOW_EXTERNAL_KEY,
  resolveDevServerBinding,
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
    expect(binding.allowedHosts).toBeUndefined()
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
    // 外部公開時は Host ヘッダが loopback 以外になるため Vite 側の検査も許可する。
    expect(binding.allowedHosts).toBe(true)
    expect(binding.warning).toBeNull()
  })

  it("'1' 以外の真値っぽい値では公開せず、警告を返す（fail-closed）", () => {
    // 'true'/'yes'/'on' を許すと「設定したつもりがない値」で公開に倒れる余地が増える。
    for (const raw of ['true', 'TRUE', 'yes', 'on', '0', '2', 'enable']) {
      const binding = resolveDevServerBinding({ [ALLOW_EXTERNAL_KEY]: raw })
      expect(binding.host, `raw=${raw}`).toBe('127.0.0.1')
      expect(binding.external, `raw=${raw}`).toBe(false)
      expect(binding.allowedHosts, `raw=${raw}`).toBeUndefined()
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
  })
})
