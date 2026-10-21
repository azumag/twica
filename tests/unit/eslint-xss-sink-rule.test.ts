import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { resolve } from 'node:path'

/**
 * eslint.config.mjs の XSS シンク禁止ルールの動作テスト。
 *
 * OBS Browser Source（sandbox 無効・旧 CEF）で動く /overlay に HTML 注入経路を
 * 作らないための再発防止策が、書き方（ドット記法 / 文字列リテラルのブラケット記法）に
 * 依存せず効くことを、実際の設定ファイルを読み込んで固定する。
 * 通常の feature → preview PR では CI の lint job が走らないため、ルールの効きは
 * この unit test（test job）でも担保する。
 */
// eslint-i18n-rule.test.ts と同じ理由で import.meta.url ではなく cwd から解決する
const configPath = resolve(process.cwd(), 'eslint.config.mjs')
const eslint = new ESLint({ overrideConfigFile: configPath })

async function sinkMessages(code: string, filePath = 'src/__xss_probe__.tsx') {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.filter(
    (m) =>
      m.ruleId === 'no-restricted-syntax' ||
      m.ruleId === 'react/no-danger' ||
      m.ruleId === 'no-eval' ||
      m.ruleId === 'no-implied-eval' ||
      m.ruleId === 'no-new-func',
  )
}

const PRELUDE =
  'declare const el: HTMLElement; declare const range: Range; declare const iframe: HTMLIFrameElement; declare const s: string;\n'

describe('eslint.config.mjs（XSS シンク禁止）', () => {
  it.each([
    ['innerHTML 代入', 'el.innerHTML = s'],
    ['outerHTML 複合代入', 'el.outerHTML += s'],
    ['innerHTML 代入（ブラケット）', "el['innerHTML'] = s"],
    ['insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', s)"],
    ['insertAdjacentHTML（ブラケット）', "el['insertAdjacentHTML']('beforeend', s)"],
    ['createContextualFragment', 'range.createContextualFragment(s)'],
    ['createContextualFragment（ブラケット）', "range['createContextualFragment'](s)"],
    ['document.write', 'document.write(s)'],
    ['document.writeln（ブラケット）', "document['writeln'](s)"],
    ['window.document.write', 'window.document.write(s)'],
    ["window['document'].write", "window['document'].write(s)"],
    ['iframe.srcdoc 代入', 'iframe.srcdoc = s'],
    ['iframe.srcdoc 代入（ブラケット）', "iframe['srcdoc'] = s"],
    ['setHTMLUnsafe', 'el.setHTMLUnsafe(s)'],
    ['Document.parseHTMLUnsafe', 'Document.parseHTMLUnsafe(s)'],
    ['DOMParser#parseFromString', "new DOMParser().parseFromString(s, 'text/html')"],
    ['execCommand（insertHTML）', "document.execCommand('insertHTML', false, s)"],
    ['execCommand（ブラケット）', "document['execCommand']('insertHTML', false, s)"],
  ])('%s を検出する', async (_label, code) => {
    expect(await sinkMessages(PRELUDE + code)).toHaveLength(1)
  })

  it('dangerouslySetInnerHTML を検出する', async () => {
    const messages = await sinkMessages(
      'export const C = ({ s }: { s: string }) => <div dangerouslySetInnerHTML={{ __html: s }} />',
    )
    expect(messages.map((m) => m.ruleId)).toEqual(['react/no-danger'])
  })

  it.each([
    ['srcDoc', 'export const C = ({ s }: { s: string }) => <iframe srcDoc={s} />'],
    ['srcdoc（小文字）', 'export const C = ({ s }: { s: string }) => <iframe srcdoc={s} />'],
  ])('JSX の %s 属性を検出する', async (_label, code) => {
    expect(await sinkMessages(code)).toHaveLength(1)
  })

  it('workers/ 配下にも適用される', async () => {
    expect(await sinkMessages(PRELUDE + 'el.innerHTML = s', 'workers/overlay-realtime/src/probe.ts'))
      .toHaveLength(1)
  })

  it.each([
    ['eval', 'eval(s)', 'no-eval'],
    ['window.eval', 'window.eval(s)', 'no-eval'],
    ['new Function', 'new Function(s)', 'no-new-func'],
    ['setTimeout 文字列', "setTimeout('alert(s)', 100)", 'no-implied-eval'],
    ['setInterval 文字列', "setInterval('alert(s)')", 'no-implied-eval'],
  ])('eval 系の %s を検出する', async (_label, code, ruleId) => {
    const messages = await sinkMessages(PRELUDE + code)
    expect(messages).toHaveLength(1)
    expect(messages.map((m) => m.ruleId)).toEqual([ruleId])
  })

  it('workers/ 配下の eval も検出する', async () => {
    expect(await sinkMessages(PRELUDE + 'eval(s)', 'workers/overlay-realtime/src/probe.ts'))
      .toHaveLength(1)
  })

  it.each([
    ['textContent 代入', 'el.textContent = s'],
    ["textContent 代入（ブラケット）", "el['textContent'] = s"],
    ['WritableStream#write', 'void new WritableStream().getWriter().write(s)'],
    ['write メソッドを持つ任意オブジェクト', "declare const logger: { write(v: string): void }; logger['write'](s)"],
    ['innerHTML の読み取り', 'console.log(el.innerHTML)'],
    ['iframe の src 属性', "export const C = () => <iframe src=\"/overlay/demo\" />"],
    ['setTimeout 関数', 'setTimeout(() => s, 100)'],
    ['setInterval 関数', 'setInterval(() => s)'],
  ])('%s は許可する', async (_label, code) => {
    expect(await sinkMessages(PRELUDE + code)).toEqual([])
  })
})
