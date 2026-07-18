#!/usr/bin/env node

/**
 * Maintenance write surface inventory checker (#694 Stage 5: CI enforcement)
 *
 * 背景:
 * #694 Stage 3 で、maintenance mode 中は middleware が /api 配下の write メソッド
 * (POST/PUT/PATCH/DELETE) を一律ブロックし、config/maintenance-write-surfaces.json
 * に 'allow' / 'queue-during-maintenance' として登録されたパス+メソッドのみを
 * 免除する「案B」を採用した。この設計では登録漏れが起きても安全側 (=過剰ブロック)
 * にしか倒れないため事故には直結しないが、「新しい書き込み route がメンテ中に
 * 予期せずブロックされることに開発者が気づかない」という運用上の問題は残る。
 * このスクリプトは、新規route追加時にinventoryへの登録が machine-readable に
 * 強制されるよう、CIで以下を機械的に検証する:
 *
 *   (a) 実route/inventory同期: src/app/api/**\/route.ts を走査し、POST/PUT/PATCH/
 *       DELETE をexportする全routeがinventoryに登録されていること (登録漏れ検出)。
 *       逆にinventoryに載っているが実在しないroute+methodも検出する (stale entry)。
 *       GET (redirect behavior 用) はmiddlewareの一律ブロック対象外であり、この
 *       同期チェックのスコープ外 (src/middleware.ts:22 の MAINTENANCE_GUARDED_METHODS
 *       と同じ4メソッドのみを対象にする)。
 *
 *   (b) メソッド検出はgrepではなくTypeScript Compiler APIで行う (issueの要求
 *       「ASTまたは安定した静的解析、単純grepだけに依存しない」)。
 *       `export async function POST` 形式、`export const POST = ...` 形式、
 *       `export const { POST } = handlers` のような分割代入形式の3つを検出する。
 *       `export { POST } from './other'` のような、このファイル単体では解決
 *       できない re-export 形を見つけた場合は fail-closed (エラーにして手動での
 *       inventory登録確認を要求する) にする。`export default function POST(){}`
 *       はdefault exportであり、Next.jsがroute handlerとして認識する named export
 *       "POST" にはならないため検出対象から除外する (hasExportModifier参照)。
 *
 *   (c) config/maintenance-write-surfaces.json 自体のスキーマ検証。
 *       validateSchema() がこのルールの単一の実装元 (single source of truth)。
 *       tests/unit/maintenance-write-surfaces-schema.test.ts は実configに対して
 *       validateSchema() が空配列を返すことだけを確認する薄いラッパーであり、
 *       ルールそのものの重複実装は持たない (ルール単位のfixtureテストは
 *       tests/unit/check-maintenance-surfaces.test.ts に集約)。
 *
 *   (d) route path の導出: `src/app/api/cards/[id]/route.ts` のような
 *       ファイルパスを `/api/cards/[id]` というURLパスへ変換し、inventoryの
 *       path表記と突き合わせる。
 *
 * 既知のスコープ制約 (現時点でリポジトリに該当ファイルが無いことは確認済み):
 *   - `route.js` (拡張子違い) は走査対象外。src/app/api配下は現状全てroute.tsのみ
 *     (`find src/app/api -name route.js` は0件)。
 *   - Next.jsのroute group (`(group)` ディレクトリ) はURLパスに現れないが、
 *     deriveRoutePath はディレクトリ名をそのままパスへ変換するため、route group
 *     を導入した場合はinventoryのpath表記と乖離する可能性がある。src/app/api配下に
 *     route groupは現状存在しない (`find src/app/api -type d -name '(*)'` は0件)。
 *
 * 期限管理について:
 * inventoryのスキーマにはreviewedAtはあるがexpires (失効日) フィールドは
 * 無い設計のため、reviewedAtの失効チェックはfailさせない。ただし
 * 'allow' / 'queue-during-maintenance' (=middlewareのブロックを免除される
 * エントリ) のreviewedAtが著しく古い場合は、免除設定がまだ妥当か再確認を
 * 促す軽量な警告 (非ブロッキング) のみ出す。
 *
 * 使い方:
 *   node scripts/check-maintenance-surfaces.js
 *   npm run check:maintenance-surfaces
 */

'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript')

const REPO_ROOT = path.join(__dirname, '..')
const API_DIR = path.join(REPO_ROOT, 'src', 'app', 'api')
const INVENTORY_PATH = path.join(REPO_ROOT, 'config', 'maintenance-write-surfaces.json')

// src/middleware.ts:22 の MAINTENANCE_GUARDED_METHODS と同一。
// GET は 'redirect' behavior 用の別経路 (route側でguardWriteRedirectを個別呼び出し)
// であり、middlewareの一律ブロック対象外なのでこのスクリプトの同期チェック対象外。
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

const VALID_BEHAVIORS = ['block', 'allow', 'redirect', 'queue-during-maintenance']
const EXEMPT_BEHAVIORS = ['allow', 'queue-during-maintenance']
const REQUIRED_STRING_FIELDS = ['path', 'category', 'maintenanceBehavior', 'reason', 'owner', 'reviewedAt']
const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

// 'allow' / 'queue-during-maintenance' のreviewedAtがこの日数より古い場合に警告する
// (fail はしない。inventoryにexpiresフィールドが無い設計を踏まえた軽量な鮮度チェック)。
const STALE_REVIEW_WARNING_DAYS = 180

/**
 * repo-root相対のroute.tsファイルパスをNext.jsのURLパスへ変換する純粋関数。
 * 例: 'src/app/api/cards/[id]/route.ts' -> '/api/cards/[id]'
 *     'src/app/api/cards/route.ts'      -> '/api/cards'
 *
 * @param {string} relativeFilePath repo rootからの相対パス (OSのpath区切り文字可)
 * @returns {string}
 */
function deriveRoutePath(relativeFilePath) {
  // OSのパス区切り文字に関わらず判定できるよう、'\' を明示的に '/' へ正規化する
  // (path.sep依存だと、darwin/linuxで実行した場合にWindows形式のバックスラッシュ
  // 区切りパスを正しく扱えない)。
  const normalized = relativeFilePath.replace(/\\/g, '/')
  const marker = 'src/app/api'
  const markerIndex = normalized.indexOf(marker)
  if (markerIndex === -1) {
    throw new Error(`src/app/api 配下のファイルではありません: ${relativeFilePath}`)
  }

  const suffix = '/route.ts'
  let rest = normalized.slice(markerIndex + marker.length)
  if (!rest.endsWith(suffix)) {
    throw new Error(`route.ts ファイルではありません: ${relativeFilePath}`)
  }
  rest = rest.slice(0, -suffix.length)

  return `/api${rest}`
}

/**
 * ノードが「named exportとして」export修飾子を持つかどうかを判定する。
 *
 * `export default function POST() {}` は ExportKeyword と DefaultKeyword の
 * 両方を修飾子に持つが、これは default export であり、Next.jsがroute handler
 * として認識する named export ("POST" という名前でimportできるbinding) には
 * ならない (POSTという識別子はファイル内のローカル参照にのみ使える)。
 * そのため ExportKeyword があっても DefaultKeyword を伴う場合は false を返す。
 * (VariableStatement は文法上 DefaultKeyword を修飾子に持てないため、この
 * 除外はFunctionDeclaration/ClassDeclarationにのみ実質的に影響する。)
 *
 * @param {import('typescript').Node} node
 * @returns {boolean}
 */
function hasExportModifier(node) {
  if (!ts.canHaveModifiers(node)) return false
  const modifiers = ts.getModifiers(node)
  if (!modifiers) return false
  const hasExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  const hasDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  return hasExport && !hasDefault
}

/**
 * VariableDeclarationのバインディング名から、静的に確定するトップレベルの
 * 識別子名を再帰的に収集する純粋関数。
 *
 * `export const POST = ...` のような単純なIdentifierだけでなく、
 * `export const { POST } = handlers` (ObjectBindingPattern) や
 * `export const { post: POST } = handlers` (プロパティ名のリネーム) 、
 * `export const [POST] = handlers` (ArrayBindingPattern) のような分割代入
 * export も対象にする。これらは元のオブジェクト/配列の中身がどんな値かは
 * 実行時にしか分からないが、「POSTという名前のbindingがこのモジュールから
 * exportされる」という事実自体はAST上で静的に確定するため、re-exportとは
 * 異なりfail-closed (unresolved) にする必要はない。
 *
 * @param {import('typescript').BindingName} bindingName
 * @returns {string[]}
 */
function collectBindingNames(bindingName) {
  if (ts.isIdentifier(bindingName)) {
    return [bindingName.text]
  }

  const names = []
  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      if (ts.isOmittedExpression(element)) continue // `const [, POST] = x` の穴あき要素
      names.push(...collectBindingNames(element.name))
    }
  }
  return names
}

/**
 * route.ts のソースコードをTypeScript Compiler APIでパースし、トップレベルで
 * export されている書き込みHTTPメソッド (WRITE_METHODS) 名を抽出する純粋関数。
 *
 * 検出するexport形:
 *   - `export async function POST(...) {}` などのFunctionDeclaration
 *     (ただし `export default function POST(){}` はdefault exportなので除外。
 *     hasExportModifier参照)
 *   - `export const POST = ...` などのVariableStatement (単純なIdentifier)
 *   - `export const { POST } = handlers` / `export const [POST] = handlers`
 *     のような分割代入VariableStatement (collectBindingNames参照)
 *   - `export { POST }` (ローカル宣言のre-export list。from節が無いため
 *     このファイル内で名前解決でき、静的に解決可能とみなす)
 *
 * fail-closedにする (unresolvedへ積む) export形:
 *   - `export { POST } from './other'` のような、他モジュールからのre-export。
 *     このファイル単体を見ただけでは実際に POST をexportしているか判定できない。
 *   - `export * from './other'` のようなwildcard re-export。何がexportされて
 *     いるか一切判定できない。
 *
 * @param {string} sourceText route.tsファイルの内容
 * @param {string} fileNameForDiagnostics エラーメッセージに使うファイル名 (診断用途のみ)
 * @returns {{ methods: string[], unresolved: Array<{ method: string | null, reason: string }> }}
 */
function extractRouteWriteExports(sourceText, fileNameForDiagnostics) {
  const sourceFile = ts.createSourceFile(
    fileNameForDiagnostics,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )

  const methods = new Set()
  const unresolved = []

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const name = stmt.name.text
      if (WRITE_METHODS.includes(name)) methods.add(name)
      continue
    }

    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        for (const name of collectBindingNames(decl.name)) {
          if (WRITE_METHODS.includes(name)) methods.add(name)
        }
      }
      continue
    }

    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue // 型のみのexportは実行時のroute handlerになり得ない

      const isWildcard = !stmt.exportClause
      if (stmt.moduleSpecifier) {
        // 他モジュールからのre-export (`from` 節あり)。このファイル単体では
        // 実際に何がexportされているか判定できないため、常にfail-closedにする。
        if (isWildcard) {
          unresolved.push({
            method: null,
            reason: "'export * from ...' は静的に解決できません",
          })
        } else if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            const publicName = el.name.text
            if (WRITE_METHODS.includes(publicName)) {
              unresolved.push({
                method: publicName,
                reason: `'export { ${publicName} } from ...' は静的に解決できません`,
              })
            }
          }
        }
      } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        // `from` 節の無い named export list (`export { POST }`)。
        // 参照先はこのファイル内のローカル宣言なので静的に解決可能とみなす。
        for (const el of stmt.exportClause.elements) {
          const publicName = el.name.text
          if (WRITE_METHODS.includes(publicName)) {
            methods.add(publicName)
          }
        }
      }
      continue
    }
  }

  return { methods: [...methods].sort(), unresolved }
}

/**
 * 実routeから抽出した (path, methods) の一覧と、inventoryのエントリを突き合わせ、
 * 登録漏れ (missing) とstale entry (stale) を検出する純粋関数。
 *
 * どちらの側も methods を WRITE_METHODS に絞り込んでから比較する。GET のみを
 * 持つエントリ (redirect behavior) は比較対象に含まれず、双方向のチェックから
 * 除外される (仕様上のスコープ外であり、無登録でもstale扱いにもならない)。
 *
 * @param {Array<{ path: string, methods: string[] }>} actualRoutes
 * @param {Array<{ path: string, methods: string[] }>} inventoryEntries
 * @returns {{ missing: string[], stale: string[] }} "METHOD PATH" 形式の一覧 (ソート済み)
 */
function diffRouteInventory(actualRoutes, inventoryEntries) {
  const toWriteKeys = (entries) => {
    const keys = new Set()
    for (const entry of entries) {
      for (const method of entry.methods) {
        if (WRITE_METHODS.includes(method)) keys.add(`${method} ${entry.path}`)
      }
    }
    return keys
  }

  const actualKeys = toWriteKeys(actualRoutes)
  const inventoryKeys = toWriteKeys(inventoryEntries)

  const missing = [...actualKeys].filter((k) => !inventoryKeys.has(k)).sort()
  const stale = [...inventoryKeys].filter((k) => !actualKeys.has(k)).sort()

  return { missing, stale }
}

/**
 * config/maintenance-write-surfaces.json の1エントリずつのスキーマを検証する純粋関数。
 *
 * このスキーマ検査ルールの単一の実装元 (single source of truth)。
 * tests/unit/maintenance-write-surfaces-schema.test.ts は実configに対してこの
 * 関数が空配列を返すことだけを確認する薄いラッパーであり、ルール自体を重複実装
 * しない (ルール単位のfixtureテストは tests/unit/check-maintenance-surfaces.test.ts
 * 側に集約する)。vitestに依存しない独立したCLIスクリプトとしても
 * `node scripts/check-maintenance-surfaces.js` 単体で完結して実行できる。
 *
 * 検証するルール: 必須フィールド (REQUIRED_STRING_FIELDS) の存在、methods の
 * 非空配列/正当なHTTPメソッド文字列、maintenanceBehaviorの4値制約、pathが
 * "/api/"始まり、reviewedAtがDate.parse可能、allow/queue-during-maintenanceの
 * pathが末尾スラッシュでないこと、redirectはmethodsが['GET']のみであること、
 * blockはmethodsにGETを含まないこと、path+methodの組み合わせに重複が無いこと。
 *
 * @param {unknown} data JSON.parseした生データ
 * @returns {string[]} エラーメッセージの一覧 (空配列ならvalid)
 */
function validateSchema(data) {
  const errors = []

  if (!Array.isArray(data) || data.length === 0) {
    errors.push('config/maintenance-write-surfaces.json は1件以上を持つ配列である必要があります')
    return errors
  }

  const seenPathMethod = new Set()

  data.forEach((entry, index) => {
    const label =
      entry && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : `#${index}`

    if (!entry || typeof entry !== 'object') {
      errors.push(`[${label}] エントリがオブジェクトではありません`)
      return
    }

    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        errors.push(`[${label}] 必須フィールド "${field}" が空でない文字列として存在しません`)
      }
    }

    if (!Array.isArray(entry.methods) || entry.methods.length === 0) {
      errors.push(`[${label}] methods は1件以上を持つ配列である必要があります`)
    } else {
      for (const method of entry.methods) {
        if (typeof method !== 'string' || !VALID_HTTP_METHODS.includes(method)) {
          errors.push(`[${label}] methods に不正な値があります: ${JSON.stringify(method)}`)
        }
      }
    }

    if (typeof entry.maintenanceBehavior === 'string' && !VALID_BEHAVIORS.includes(entry.maintenanceBehavior)) {
      errors.push(`[${label}] maintenanceBehavior が不正です: ${entry.maintenanceBehavior}`)
    }

    if (typeof entry.path === 'string' && !entry.path.startsWith('/api/')) {
      errors.push(`[${label}] path は "/api/" で始まる必要があります`)
    }

    // reviewedAt が Date.parse可能な文字列であること (records用の日付として不正な
    // 値が紛れ込むと、collectStaleReviewWarnings の鮮度チェックが常にスキップ
    // される=事実上機能しなくなるため、ここで検証しておく)。
    if (typeof entry.reviewedAt === 'string' && Number.isNaN(Date.parse(entry.reviewedAt))) {
      errors.push(`[${label}] reviewedAt がDate.parse可能な文字列ではありません: ${entry.reviewedAt}`)
    }

    // maintenanceBehavior: 'redirect' はGET専用の別経路 (routeがguardWriteRedirect
    // を個別に呼ぶ) であり、middlewareの一律ブロック(POST/PUT/PATCH/DELETE)対象外
    // であることをmethodsで明示する規約。methodsが['GET']以外だとこの前提が崩れる。
    if (
      typeof entry.maintenanceBehavior === 'string' &&
      entry.maintenanceBehavior === 'redirect' &&
      Array.isArray(entry.methods) &&
      !(entry.methods.length === 1 && entry.methods[0] === 'GET')
    ) {
      errors.push(
        `[${label}] maintenanceBehavior: 'redirect' のエントリはmethodsが['GET']のみである必要があります: ${JSON.stringify(entry.methods)}`
      )
    }

    // maintenanceBehavior: 'block' はwrite methodの棚卸し対象であり、GETを含めると
    // 「GETのみのルートは棚卸し対象外」という設計上の前提と矛盾する
    // (GETを一律ブロックする意図なら'redirect'を使うべき)。
    if (
      typeof entry.maintenanceBehavior === 'string' &&
      entry.maintenanceBehavior === 'block' &&
      Array.isArray(entry.methods) &&
      entry.methods.includes('GET')
    ) {
      errors.push(`[${label}] maintenanceBehavior: 'block' のエントリはmethodsにGETを含められません`)
    }

    if (
      typeof entry.path === 'string' &&
      typeof entry.maintenanceBehavior === 'string' &&
      EXEMPT_BEHAVIORS.includes(entry.maintenanceBehavior) &&
      entry.path.endsWith('/')
    ) {
      errors.push(
        `[${label}] allow/queue-during-maintenance の path は末尾スラッシュ禁止です (prefix一致に化けて免除範囲が広がるため)`
      )
    }

    if (typeof entry.path === 'string' && Array.isArray(entry.methods)) {
      for (const method of entry.methods) {
        if (typeof method !== 'string') continue
        const key = `${method} ${entry.path}`
        if (seenPathMethod.has(key)) {
          errors.push(`path + method の組み合わせが重複しています: ${key}`)
        }
        seenPathMethod.add(key)
      }
    }
  })

  return errors
}

/**
 * 'allow' / 'queue-during-maintenance' エントリのうち、reviewedAtが
 * STALE_REVIEW_WARNING_DAYS 日より古いものについて警告メッセージを返す純粋関数。
 * inventoryにexpiresフィールドが無い設計のため、これはfailしない軽量な鮮度チェック。
 *
 * @param {Array<{ path: string, maintenanceBehavior: string, reviewedAt: string }>} entries
 * @param {number} now 比較基準時刻 (epoch ms)。テスト容易性のため引数化 (省略時はDate.now())
 * @returns {string[]}
 */
function collectStaleReviewWarnings(entries, now = Date.now()) {
  const warnings = []
  const thresholdMs = STALE_REVIEW_WARNING_DAYS * 24 * 60 * 60 * 1000

  for (const entry of entries) {
    if (!entry || !EXEMPT_BEHAVIORS.includes(entry.maintenanceBehavior)) continue
    const reviewedAtMs = Date.parse(entry.reviewedAt)
    if (Number.isNaN(reviewedAtMs)) continue // 不正な日付はvalidateSchema側で別途エラーになる

    if (now - reviewedAtMs > thresholdMs) {
      const ageDays = Math.floor((now - reviewedAtMs) / (24 * 60 * 60 * 1000))
      warnings.push(
        `${entry.path} (${entry.maintenanceBehavior}) の reviewedAt が${ageDays}日前と古いです ` +
          `(${entry.reviewedAt})。免除設定がまだ妥当か再確認してください`
      )
    }
  }

  return warnings
}

/** src/app/api 配下の route.ts ファイル一覧 (絶対パス) を再帰的に収集する。 */
function listRouteFiles() {
  const results = []

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && entry.name === 'route.ts') {
        results.push(fullPath)
      }
    }
  }

  walk(API_DIR)
  return results
}

function main() {
  const allErrors = []

  let inventory
  try {
    const raw = fs.readFileSync(INVENTORY_PATH, 'utf8')
    inventory = JSON.parse(raw)
  } catch (err) {
    console.error(
      `config/maintenance-write-surfaces.json の読み込み/パースに失敗しました: ${
        err && err.message ? err.message : err
      }`
    )
    process.exit(1)
    return
  }

  // (c) スキーマ検証
  allErrors.push(...validateSchema(inventory))

  // (a)(b) 実routeの走査とTypeScript Compiler APIによるメソッド抽出
  const routeFiles = listRouteFiles()
  const actualRoutes = []
  for (const absolutePath of routeFiles) {
    const relativePath = path.relative(REPO_ROOT, absolutePath)
    const source = fs.readFileSync(absolutePath, 'utf8')
    const { methods, unresolved } = extractRouteWriteExports(source, relativePath)

    if (methods.length > 0) {
      actualRoutes.push({ path: deriveRoutePath(relativePath), methods })
    }

    for (const u of unresolved) {
      allErrors.push(
        `構文的に解決できないexportです (${relativePath}): ${u.reason} ` +
          '実際に書き込みメソッド(POST/PUT/PATCH/DELETE)をexportしている場合は、' +
          'config/maintenance-write-surfaces.json に手動で登録してください'
      )
    }
  }

  // (a) 実route/inventory同期 (登録漏れ + stale entry)
  if (Array.isArray(inventory)) {
    const { missing, stale } = diffRouteInventory(actualRoutes, inventory)
    for (const key of missing) {
      allErrors.push(
        `登録漏れ: "${key}" はroute.tsでexportされていますが、` +
          'config/maintenance-write-surfaces.json に登録されていません。' +
          'メンテナンス中に予期せずブロックされる可能性があるため、エントリを追加してください。'
      )
    }
    for (const key of stale) {
      allErrors.push(
        `stale entry: "${key}" はconfig/maintenance-write-surfaces.json に登録されていますが、` +
          '対応するroute.tsのexportが見つかりません。routeが削除/リネームされた場合はエントリも削除してください。'
      )
    }
  }

  // 軽量な鮮度チェック (fail しない)
  if (Array.isArray(inventory)) {
    const warnings = collectStaleReviewWarnings(inventory)
    if (warnings.length > 0) {
      console.warn(`[check-maintenance-surfaces] 警告 (${warnings.length}件、CIは失敗させません):`)
      for (const w of warnings) {
        console.warn(`  - ${w}`)
      }
    }
  }

  if (allErrors.length > 0) {
    console.error('maintenance write surface のチェックに失敗しました:\n')
    for (const error of allErrors) {
      console.error(`  - ${error}`)
    }
    console.error(
      '\n新しい書き込みroute (POST/PUT/PATCH/DELETE) を追加した場合は、' +
        'config/maintenance-write-surfaces.json にエントリを追加してください。' +
        '詳細は同ファイル内の既存エントリとissue #694を参照してください。'
    )
    process.exit(1)
    return
  }

  console.log(
    `[check-maintenance-surfaces] OK: route ${routeFiles.length}件中${actualRoutes.length}件の書き込みroute、` +
      `inventory ${Array.isArray(inventory) ? inventory.length : 0}件が同期しています`
  )
}

if (require.main === module) {
  main()
}

module.exports = {
  deriveRoutePath,
  extractRouteWriteExports,
  diffRouteInventory,
  validateSchema,
  collectStaleReviewWarnings,
}
