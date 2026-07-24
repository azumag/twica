import { describe, expect, it } from 'vitest'
import { findViolations, listScannableFiles } from '../../scripts/check-analysis-browser-supabase.js'

describe('findViolations', () => {
  it('違反が無ければ空配列を返す', () => {
    const content = `
      import { adminApi } from '../lib/adminApi'
      export function Foo() { return adminApi.getStreamers() }
    `
    expect(findViolations(content)).toEqual([])
  })

  it('@supabase/supabase-js のimportを検出する', () => {
    const content = `import { createClient } from '@supabase/supabase-js'`
    const violations = findViolations(content)
    expect(violations).toEqual([{ line: 1, kind: 'supabase-import', text: content }])
  })

  it('@supabase配下の任意サブパッケージのimportも検出する', () => {
    const content = `import { AuthError } from "@supabase/auth-js"`
    const violations = findViolations(content)
    expect(violations).toHaveLength(1)
    expect(violations[0].kind).toBe('supabase-import')
  })

  it('requireでの読み込みも検出する', () => {
    const content = `const { createClient } = require('@supabase/supabase-js')`
    const violations = findViolations(content)
    expect(violations).toHaveLength(1)
    expect(violations[0].kind).toBe('supabase-import')
  })

  it('バッククォートで囲んだ動的importも検出する', () => {
    const content = 'const mod = await import(`@supabase/supabase-js`)'
    const violations = findViolations(content)
    expect(violations).toHaveLength(1)
    expect(violations[0].kind).toBe('supabase-import')
  })

  it('VITE_*SUPABASE*形式の環境変数参照を検出する', () => {
    const content = `const url = import.meta.env.VITE_DASHBOARD_SUPABASE_URL`
    const violations = findViolations(content)
    expect(violations).toEqual([{ line: 1, kind: 'supabase-env', text: content }])
  })

  it('Node側のSupabase service-role環境変数参照も検出する', () => {
    const content = `const key = env.DASHBOARD_SUPABASE_SECRET_KEY`
    expect(findViolations(content)).toEqual([
      { line: 1, kind: 'supabase-env', text: content },
    ])
  })

  it('別の命名のVITE変数やSUPABASE単体は誤検知しない', () => {
    const content = `
      const apiBase = import.meta.env.VITE_API_BASE_URL
      const label = 'Supabaseからの移行完了'
    `
    expect(findViolations(content)).toEqual([])
  })

  it('複数行・複数種の違反を行番号付きですべて収集する', () => {
    const content = [
      `import { createClient } from '@supabase/supabase-js'`,
      `const key = import.meta.env.VITE_DASHBOARD_SUPABASE_ANON_KEY`,
    ].join('\n')

    const violations = findViolations(content)
    expect(violations).toEqual([
      { line: 1, kind: 'supabase-import', text: expect.stringContaining('@supabase/supabase-js') },
      { line: 2, kind: 'supabase-env', text: expect.stringContaining('VITE_DASHBOARD_SUPABASE_ANON_KEY') },
    ])
  })
})

describe('listScannableFiles', () => {
  it('存在しないディレクトリに対しては空配列を返す（呼び出し元がfail-closedにする前提の挙動）', () => {
    // main()側はこの「空配列」を「走査対象を見失った」シグナルとして扱いexit 1する
    // (fail-open防止)。この関数自体は素直に空配列を返すだけで良い
    expect(listScannableFiles('/nonexistent/path/that/should/not/exist')).toEqual([])
  })
})
