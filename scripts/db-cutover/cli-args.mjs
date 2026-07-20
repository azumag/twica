#!/usr/bin/env node

/**
 * db:cutover:verify CLIの引数解析 / Issue #697 Chunk 1 タスク8
 *
 * 設計判断（1コマンド + --layers方式、Issue #697本文どおり）:
 * 原issueは db:cutover:verify-schema 等5個の独立npm scriptsを提案していたが、レビューの結果
 * 単一エントリポイント `db:cutover:verify -- --layers=identity,schema` に統合した
 * （中間結果ファイルの整合管理という不要な複雑性を避けるため）。
 *
 * 接続文字列について（db-migrate.js/init-identity.mjsと同じ方針）:
 * `--source-url`/`--target-url` というCLIフラグは実装しない。Issue #697本文は
 * 「--source-url / --target-url（または環境変数、db-migrate.jsの流儀に合わせる）」と、
 * 環境変数方式を明示的な代替として許容しているため、シェル履歴・`ps aux` 等への秘密情報漏洩を
 * 避ける本プロジェクトの既存方針（DATABASE_URLは環境変数専用）と一貫させ、
 * `SOURCE_DATABASE_URL`/`TARGET_DATABASE_URL` 環境変数のみを受け付ける設計にした
 * （CLIフラグ経路を用意しないことで、誤って安全でない方を使ってしまうリスクそのものを無くす）。
 */

'use strict'

import { VALID_IDENTITY_ENVIRONMENTS, VALID_IDENTITY_PROVIDERS } from './identity-store.mjs'
import { DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE } from './layer-data.mjs'

/**
 * 本チャンクで実装済みのlayer名（--layersで指定可能な値）。
 *
 * Minor-7（Fableレビュー）: 当初はreport.mjsに置いていたが、buildReport（report.mjsの本体）は
 * この定数を一切参照せず、専らCLI引数バリデーション（本ファイル）のためだけに存在していた。
 * 「report.mjsがcli-args.mjsに依存される」という向きのねじれを解消するため、CLI引数の関心事は
 * cli-args.mjs側に置く（buildReportへは`requestedLayers`として実行時に渡すだけで十分であり、
 * report.mjs自身がこのリストを知る必要はない）。
 *
 * `data`（Layer 3件数/key range統計 + Layer 4 checksum、Issue #697 Chunk 2で実装）を追加。
 * schema.tsに定義された全テーブルを対象にするため、identity/schemaより実行時間が長くなりうる
 * （`--chunk-size`で調整可能。下記parseChunkSize参照）。
 *
 * `invariants`（Layer 5業務invariant、Issue #697 Chunk 3で実装）を追加。source/target双方に
 * 対しTier A（絶対値fail）/Tier B（source/target両側一致型）の判定を行う
 * （詳細はlayer-invariants.mjs / invariant-checks.mjs参照）。
 */
export const IMPLEMENTED_LAYERS = ['identity', 'schema', 'data', 'invariants']

/**
 * Issue #697原文が定義する6層のうち、まだ未実装のlayer名。CLIが「不明な引数」ではなく
 * 「未実装」という区別可能なエラーメッセージを出すために使う。
 */
export const KNOWN_FUTURE_LAYERS = ['canary']

const KNOWN_BOOLEAN_FLAGS = ['--help', '-h', '--allow-skip-identity']

const HELP_TEXT = `
使い方:
  SOURCE_DATABASE_URL="postgres://..." TARGET_DATABASE_URL="postgres://..." \\
    node scripts/db-cutover/verify.mjs \\
    --source-environment=<production|preview> --source-provider=<supabase|planetscale> \\
    --target-environment=<production|preview> --target-provider=<supabase|planetscale> \\
    --layers=identity,schema [--operation-id=<任意文字列>]

  npm run db:cutover:verify -- --source-environment=production --source-provider=supabase \\
    --target-environment=production --target-provider=planetscale --layers=identity,schema \\
    --operation-id=cutover-2026-08-01

説明:
  source（例: Supabase）と target（例: PlanetScale）を比較し、cutoverのGO/NO-GO判定材料となる
  JSON report を出力する。source/targetのどちらか一方でも --*-environment=production が
  指定された場合、追加で --operation-id の指定が必須になる（本番実行時の誤操作防止）。

オプション（全て必須。省略時のデフォルト推測は行わない）:
  --source-environment=<production|preview>
  --target-environment=<production|preview>
  --source-provider=<supabase|planetscale>
  --target-provider=<supabase|planetscale>
  --layers=<カンマ区切り>          現在有効な値: ${IMPLEMENTED_LAYERS.join(', ')}
                                    （${KNOWN_FUTURE_LAYERS.join('/')} は後続チャンクで追加予定、
                                    現時点で指定すると「未実装」エラーになる）
  --operation-id=<文字列>          production実行時のみ必須
  --allow-skip-identity            --layers に identity を含めない場合に必須（下記参照）
  --chunk-size=<正の整数>          dataレイヤーのchunkサイズ（既定: ${DEFAULT_CHUNK_SIZE}行、
                                    上限: ${MAX_CHUNK_SIZE}行）。dataレイヤーを実行しない場合は無視される
  --help, -h                       このヘルプを表示する

--layers に identity を含めない場合について:
  identity layerはsource/targetの取り違え・環境取り違えを検知する、このツールの安全性の
  中核である。誤ってこの検知を経ずに他layerだけを実行してしまう事故を防ぐため、
  --layers に identity を含めない場合は --allow-skip-identity の明示指定を必須にしている
  （schema layer単体でのデバッグ・開発時など、意図的にidentity検証をスキップしたい
  場合にのみ使うこと）。

環境変数（必須）:
  SOURCE_DATABASE_URL   source接続文字列
  TARGET_DATABASE_URL   target接続文字列

環境変数（任意）:
  PG_DUMP_BIN           pg_dump バイナリのパス（既定: "pg_dump"、PATH経由で解決。schemaレイヤーでのみ使用）
`.trim()

export { HELP_TEXT }

/**
 * CLI引数を解析する純粋関数（db-migrate.js の parseArgs と同じ「未知フラグを黙って無視しない」流儀）。
 * @param {string[]} argv
 */
export function parseVerifyArgs(argv) {
  const args = argv.slice(2)
  const help = args.includes('--help') || args.includes('-h')
  const allowSkipIdentity = args.includes('--allow-skip-identity')

  let sourceEnvironment, targetEnvironment, sourceProvider, targetProvider, layersRaw, operationId, chunkSizeRaw
  const unknownArgs = []
  // オーケストレーターレビュー Minor-7対応: 同一フラグを複数回指定すると、以前はFLAG_SETTERSが
  // 単に上書きし「黙って後勝ち」になっていた（例: `--layers=identity --layers=schema` で
  // ユーザーは両方指定したつもりでも実際にはschemaのみが有効になる）。未知フラグは
  // 「不明な引数」として明示的に拒否する厳格方針と非対称だったため、重複指定も検知して拒否する。
  const seenFlags = new Set()
  const duplicateArgs = []

  const FLAG_SETTERS = {
    '--source-environment=': (v) => (sourceEnvironment = v),
    '--target-environment=': (v) => (targetEnvironment = v),
    '--source-provider=': (v) => (sourceProvider = v),
    '--target-provider=': (v) => (targetProvider = v),
    '--layers=': (v) => (layersRaw = v),
    '--operation-id=': (v) => (operationId = v),
    '--chunk-size=': (v) => (chunkSizeRaw = v),
  }

  for (const arg of args) {
    if (KNOWN_BOOLEAN_FLAGS.includes(arg)) continue
    const prefix = Object.keys(FLAG_SETTERS).find((p) => arg.startsWith(p))
    if (prefix) {
      if (seenFlags.has(prefix)) {
        duplicateArgs.push(arg)
        continue
      }
      seenFlags.add(prefix)
      FLAG_SETTERS[prefix](arg.slice(prefix.length))
      continue
    }
    unknownArgs.push(arg)
  }

  return {
    help,
    allowSkipIdentity,
    sourceEnvironment,
    targetEnvironment,
    sourceProvider,
    targetProvider,
    layersRaw,
    operationId,
    chunkSizeRaw,
    unknownArgs,
    duplicateArgs,
  }
}

/**
 * `--chunk-size` の値を検証する純粋関数。`1`〜`MAX_CHUNK_SIZE`の整数のみを許容する。
 * 未指定時は呼び出し側（resolveVerifyConfig）がDEFAULT_CHUNK_SIZEを補う。
 *
 * 上限を設ける理由（Fableレビュー Minor対応）: 上限が無いと、誤って巨大な値
 * （例: テーブルの全行数を上回る値）を指定した場合、1chunkとして全行を一括で
 * メモリ上に保持してしまい、メモリ枯渇のリスクがある。
 * @param {string | undefined} chunkSizeRaw
 * @returns {{ error?: string, chunkSize?: number }}
 */
export function parseChunkSize(chunkSizeRaw) {
  if (chunkSizeRaw === undefined) return { chunkSize: DEFAULT_CHUNK_SIZE }
  // Number()は空文字列を0にする等の緩さがあるため、trim()適用後に「10進整数のみで
  // 構成されているか」を先にregexで確認してから変換する。前後の空白はtrim()により
  // 意図的に許容する（2回目のFableレビュー Minor-N4対応、コメント訂正:
  // 以前は「`--chunk-size= 10`のような入力も弾く」と誤って記載していたが、実装は
  // trim()後に判定するため空白付きの入力は許容される。指数表記（`1e3`）はtrim後も
  // 数字以外の文字を含むため、下記regexで正しく弾かれる）。
  if (!/^[0-9]+$/.test(chunkSizeRaw.trim())) {
    return { error: `--chunk-size には正の整数を指定してください: ${chunkSizeRaw}` }
  }
  const chunkSize = Number(chunkSizeRaw.trim())
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    return { error: `--chunk-size には正の整数を指定してください: ${chunkSizeRaw}` }
  }
  if (chunkSize > MAX_CHUNK_SIZE) {
    return { error: `--chunk-size は ${MAX_CHUNK_SIZE} 以下を指定してください: ${chunkSizeRaw}` }
  }
  return { chunkSize }
}

/**
 * --layers の値を検証し、実行順序を IMPLEMENTED_LAYERS の順に正規化する純粋関数。
 * identity → schema の順で必ず実行する必要がある（identity mismatchで即座に停止するため）ため、
 * ユーザーが `--layers=schema,identity` のように逆順指定しても実行順は固定する。
 *
 * @param {string} layersRaw
 * @returns {{ error?: string, layers?: string[] }}
 */
export function parseLayers(layersRaw) {
  if (!layersRaw || !layersRaw.trim()) {
    return { error: `--layers は必須です（例: --layers=${IMPLEMENTED_LAYERS.join(',')}）。` }
  }
  const requested = layersRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  const futureRequested = requested.filter((l) => KNOWN_FUTURE_LAYERS.includes(l))
  if (futureRequested.length > 0) {
    return {
      // Chunk 3時点でinvariantsも実装済みになったため、文言を「Chunk 1で実装済みなのは」から
      // 汎用的な表現へ更新した（今後のチャンクでこの文言を再度直す必要が無いように）。
      error: `layer "${futureRequested.join(', ')}" はまだ未実装です（現時点で実装済みなのは ${IMPLEMENTED_LAYERS.join('/')} のみ）。`,
    }
  }
  const unknown = requested.filter((l) => !IMPLEMENTED_LAYERS.includes(l))
  if (unknown.length > 0) {
    return { error: `不明なlayerです: ${unknown.join(', ')}（有効な値: ${IMPLEMENTED_LAYERS.join('/')}）` }
  }

  // 実行順序を IMPLEMENTED_LAYERS の順に正規化（identity → schema）。
  const layers = IMPLEMENTED_LAYERS.filter((l) => requested.includes(l))
  return { layers }
}

/**
 * CLI引数・環境変数から実行設定を解決する純粋関数（help/error/正常系の3値、db-migrate.jsと同じ流儀）。
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function resolveVerifyConfig(argv, env) {
  const parsed = parseVerifyArgs(argv)
  if (parsed.help) return { help: true }

  if (parsed.unknownArgs.length > 0) {
    return { error: `不明な引数です: ${parsed.unknownArgs.join(', ')}` }
  }
  if (parsed.duplicateArgs.length > 0) {
    return { error: `フラグが重複して指定されています: ${parsed.duplicateArgs.join(', ')}` }
  }

  if (!parsed.sourceEnvironment) return { error: '--source-environment は必須です（省略時の推測は行いません）。' }
  if (!VALID_IDENTITY_ENVIRONMENTS.includes(parsed.sourceEnvironment)) {
    return { error: `--source-environment には ${VALID_IDENTITY_ENVIRONMENTS.join('/')} のいずれかを指定してください: ${parsed.sourceEnvironment}` }
  }
  if (!parsed.targetEnvironment) return { error: '--target-environment は必須です（省略時の推測は行いません）。' }
  if (!VALID_IDENTITY_ENVIRONMENTS.includes(parsed.targetEnvironment)) {
    return { error: `--target-environment には ${VALID_IDENTITY_ENVIRONMENTS.join('/')} のいずれかを指定してください: ${parsed.targetEnvironment}` }
  }

  if (!parsed.sourceProvider) return { error: '--source-provider は必須です（省略時の推測は行いません）。' }
  if (!VALID_IDENTITY_PROVIDERS.includes(parsed.sourceProvider)) {
    return { error: `--source-provider には ${VALID_IDENTITY_PROVIDERS.join('/')} のいずれかを指定してください: ${parsed.sourceProvider}` }
  }
  if (!parsed.targetProvider) return { error: '--target-provider は必須です（省略時の推測は行いません）。' }
  if (!VALID_IDENTITY_PROVIDERS.includes(parsed.targetProvider)) {
    return { error: `--target-provider には ${VALID_IDENTITY_PROVIDERS.join('/')} のいずれかを指定してください: ${parsed.targetProvider}` }
  }

  const layersResult = parseLayers(parsed.layersRaw)
  if (layersResult.error) return { error: layersResult.error }

  // Minor-6（Fableレビュー）: identity layerはsource/target取り違え検知の要であり、
  // これを含めない実行は「安全装置を意図的に外す」操作に等しい。以前はstderrへの警告のみで
  // 通していたが、明示フラグを要求することで「うっかり」を防ぐ（デバッグ・開発時に
  // identity layerを外して素早くschema layerだけ試したい、という正当な用途はある想定のため
  // 完全に禁止はせず、--allow-skip-identity を要求する形にした）。
  if (!layersResult.layers.includes('identity') && !parsed.allowSkipIdentity) {
    return {
      error:
        '--layers に identity が含まれていません。source/targetの取り違え検知が行われないまま' +
        '実行することになるため、意図的である場合は --allow-skip-identity を指定してください。',
    }
  }

  // prod実行時の安全ガード（Issue #697本文の要求）: source/targetいずれかがproductionなら
  // --operation-id を必須にする。
  const involvesProduction = parsed.sourceEnvironment === 'production' || parsed.targetEnvironment === 'production'
  if (involvesProduction && (!parsed.operationId || !parsed.operationId.trim())) {
    return { error: '--source-environment または --target-environment に production が指定されているため、--operation-id の指定が必須です。' }
  }

  const sourceUrl = env.SOURCE_DATABASE_URL
  if (!sourceUrl || !sourceUrl.trim()) {
    return { error: '環境変数 SOURCE_DATABASE_URL が設定されていません（接続文字列は環境変数でのみ受け付けます）。' }
  }
  const targetUrl = env.TARGET_DATABASE_URL
  if (!targetUrl || !targetUrl.trim()) {
    return { error: '環境変数 TARGET_DATABASE_URL が設定されていません（接続文字列は環境変数でのみ受け付けます）。' }
  }

  // オーケストレーターレビュー Minor-6対応: `parsed.operationId ?? null` は `??`
  // （nullish coalescing）が空文字列を「値あり」として扱ってしまうため、
  // `--operation-id=`（値を空にして指定）を渡すと operationId が `''` のまま
  // resolvedConfig・reportまで伝播してしまう（本番安全ガード自体は `!parsed.operationId`
  // というfalsy判定のため空文字列も正しく弾けているが、preview/preview等の
  // 非production実行では空文字列がそのまま通ってしまっていた）。trim後に空なら
  // 明示的にnull扱いにする。
  const trimmedOperationId = parsed.operationId && parsed.operationId.trim() ? parsed.operationId.trim() : null

  const chunkSizeResult = parseChunkSize(parsed.chunkSizeRaw)
  if (chunkSizeResult.error) return { error: chunkSizeResult.error }

  return {
    sourceEnvironment: parsed.sourceEnvironment,
    targetEnvironment: parsed.targetEnvironment,
    sourceProvider: parsed.sourceProvider,
    targetProvider: parsed.targetProvider,
    layers: layersResult.layers,
    operationId: trimmedOperationId,
    chunkSize: chunkSizeResult.chunkSize,
    sourceUrl,
    targetUrl,
  }
}
