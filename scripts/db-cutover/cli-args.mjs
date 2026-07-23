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
 *
 * `canary`（Layer 6 runtime canary、Issue #697 Chunk 4で実装）を追加。target側に対してのみ
 * 実際に書き込みトランザクション（fixture INSERT・RPC実行・トリガー発火）を開き、必ず
 * ROLLBACKする（詳細はlayer-canary.mjs参照）。これでIssue #697本文が定義する6層すべてが
 * IMPLEMENTED_LAYERSに揃った。
 */
export const IMPLEMENTED_LAYERS = ['identity', 'schema', 'data', 'invariants', 'canary']

/**
 * Issue #697原文が定義する6層のうち、まだ未実装のlayer名。CLIが「不明な引数」ではなく
 * 「未実装」という区別可能なエラーメッセージを出すために使う。
 *
 * Chunk 4でcanaryが実装され6層すべてがIMPLEMENTED_LAYERSへ移ったため、本チャンク時点では
 * 空配列になる。空にせず定数自体は残す理由: Issue #697本文の6層以外に将来layerが追加される
 * 可能性（例: 追加のRPCカバレッジ）に備え、「未実装」エラーメッセージを出す仕組み自体は
 * 汎用的に温存する（`parseLayers`のfutureRequestedチェックを参照。中身が空でもロジックは
 * 生きたまま維持されるため、将来layerを1つ追加するだけでこの仕組みがそのまま使える）。
 */
export const KNOWN_FUTURE_LAYERS = []

const KNOWN_BOOLEAN_FLAGS = ['--help', '-h', '--allow-skip-identity', '--fail-fast']

/** `--connect-timeout` 未指定時のデフォルト値（既存verify.mjsのハードコード値15秒を踏襲）。 */
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 15

/**
 * `--connect-timeout` に指定可能な上限（秒）。chunk-sizeと同じ思想の安全弁: 上限が無いと
 * 誤って巨大な値を指定した場合、接続不能なsource/targetに対してプロセスが長時間ハングし、
 * cutover当日のfreeze時間を圧迫するリスクがある。HELP_TEXT（このすぐ下）が参照するため、
 * parseConnectTimeout本体より前（ファイル冒頭側）で宣言する必要がある。
 */
export const MAX_CONNECT_TIMEOUT_SECONDS = 300

/**
 * Issue #697 Chunk 4対応（設計書ファイル構成4節・rev1レビューMinor-6）: KNOWN_FUTURE_LAYERSが
 * 空になったため、「（X は後続チャンクで追加予定...）」という文言をそのまま埋め込むと
 * `（ は後続チャンクで追加予定、...）`のような空の括弧書きがヘルプに出力されてしまう。
 * KNOWN_FUTURE_LAYERSが1件以上ある場合のみこの説明行を出す条件分岐にすることで、
 * 将来再びKNOWN_FUTURE_LAYERSに要素が入った場合も含め、崩れない形にする。
 */
const FUTURE_LAYERS_HELP_LINE =
  KNOWN_FUTURE_LAYERS.length > 0
    ? `\n                                    （${KNOWN_FUTURE_LAYERS.join('/')} は後続チャンクで追加予定、\n                                    現時点で指定すると「未実装」エラーになる）`
    : ''

const HELP_TEXT = `
使い方:
  SOURCE_DATABASE_URL="postgres://..." TARGET_DATABASE_URL="postgres://..." \\
    node scripts/db-cutover/verify.mjs \\
    --source-environment=<production|preview> --source-provider=<supabase|planetscale> \\
    --target-environment=<production|preview> --target-provider=<supabase|planetscale> \\
    --layers=identity,schema,data,invariants,canary [--operation-id=<任意文字列>]

  npm run db:cutover:verify -- --source-environment=production --source-provider=supabase \\
    --target-environment=production --target-provider=planetscale \\
    --layers=identity,schema,data,invariants,canary --operation-id=cutover-2026-08-01

説明:
  source（例: Supabase）と target（例: PlanetScale）を比較し、cutoverのGO/NO-GO判定材料となる
  JSON report を出力する。source/targetのどちらか一方でも --*-environment=production が
  指定された場合、追加で --operation-id の指定が必須になる（本番実行時の誤操作防止）。

主要オプション（*は必須。省略時のデフォルト推測は行わない。無印は任意）:
  --source-environment=<production|preview>  *
  --target-environment=<production|preview>  *
  --source-provider=<supabase|planetscale>   *
  --target-provider=<supabase|planetscale>   *
  --layers=<カンマ区切り>  *       現在有効な値: ${IMPLEMENTED_LAYERS.join(', ')}${FUTURE_LAYERS_HELP_LINE}
  --operation-id=<文字列>          production関与時のみ必須（それ以外は任意）
  --allow-skip-identity            任意。--layers に identity を含めない場合に必須（下記参照。
                                    canaryを含む場合はこのフラグ自体を指定できない）
  --chunk-size=<正の整数>          任意。dataレイヤーのchunkサイズ（既定: ${DEFAULT_CHUNK_SIZE}行、
                                    上限: ${MAX_CHUNK_SIZE}行）。dataレイヤーを実行しない場合は無視される
  --fail-fast                      任意。いずれかのlayerがfailしたら後続layerを実行せず打ち切る
                                    （既定はfull-report modeで、fail後も全layerを実行する。
                                    identity layerは既定でも常にfail-fast相当の挙動を持つ
                                    ため本フラグの影響を受けない）
  --connect-timeout=<正の整数>     任意。source/target接続確立のタイムアウト秒数（既定:
                                    ${DEFAULT_CONNECT_TIMEOUT_SECONDS}秒、上限: ${MAX_CONNECT_TIMEOUT_SECONDS}秒）
  --help, -h                       任意。このヘルプを表示する

--layers に identity を含めない場合について:
  identity layerはsource/targetの取り違え・環境取り違えを検知する、このツールの安全性の
  中核である。誤ってこの検知を経ずに他layerだけを実行してしまう事故を防ぐため、
  --layers に identity を含めない場合は --allow-skip-identity の明示指定を必須にしている
  （schema layer単体でのデバッグ・開発時など、意図的にidentity検証をスキップしたい
  場合にのみ使うこと）。

--layers に canary を含める場合について（Issue #697 Chunk 4、安全ガード）:
  canaryはtargetへ実際に書き込みトランザクション（fixture INSERT・RPC実行によるトリガー
  発火、最後に必ずROLLBACK）を開く。取り違え時のリスクが読み取り専用layerより本質的に
  高いため、canaryを指定する場合は --layers に identity を必ず含める必要があり、
  --allow-skip-identity は指定できない（指定するとエラー終了する。読み取り専用layerと
  異なり、canaryにはidentity検証をスキップする正当なユースケースが無いための意図的な
  非対称設計）。

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
  // Issue #697 Chunk 4: --fail-fast はブール引数（値を取らない）のため、他のKNOWN_BOOLEAN_FLAGSと
  // 同じ`args.includes()`方式で検出する（--allow-skip-identityと同じ流儀）。
  const failFast = args.includes('--fail-fast')

  let sourceEnvironment, targetEnvironment, sourceProvider, targetProvider, layersRaw, operationId, chunkSizeRaw, connectTimeoutRaw
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
    '--connect-timeout=': (v) => (connectTimeoutRaw = v),
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
    failFast,
    sourceEnvironment,
    targetEnvironment,
    sourceProvider,
    targetProvider,
    layersRaw,
    operationId,
    chunkSizeRaw,
    connectTimeoutRaw,
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
 * `--connect-timeout` の値を検証する純粋関数。postgres.jsの`connect_timeout`オプション
 * （秒単位）へそのまま渡す値になる。Issue #697本文「timeout指定可能」への対応
 * （設計書「CLI統合の残ギャップ」節）。parseChunkSizeと同じ検証方式・エラーメッセージ形式を
 * 踏襲する（複数の似た数値系フラグ間でユーザー体験を揃えるため）。
 * @param {string | undefined} connectTimeoutRaw
 * @returns {{ error?: string, connectTimeoutSeconds?: number }}
 */
export function parseConnectTimeout(connectTimeoutRaw) {
  if (connectTimeoutRaw === undefined) return { connectTimeoutSeconds: DEFAULT_CONNECT_TIMEOUT_SECONDS }
  if (!/^[0-9]+$/.test(connectTimeoutRaw.trim())) {
    return { error: `--connect-timeout には正の整数(秒)を指定してください: ${connectTimeoutRaw}` }
  }
  const connectTimeoutSeconds = Number(connectTimeoutRaw.trim())
  if (!Number.isSafeInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1) {
    return { error: `--connect-timeout には正の整数(秒)を指定してください: ${connectTimeoutRaw}` }
  }
  if (connectTimeoutSeconds > MAX_CONNECT_TIMEOUT_SECONDS) {
    return { error: `--connect-timeout は ${MAX_CONNECT_TIMEOUT_SECONDS} 以下を指定してください: ${connectTimeoutRaw}` }
  }
  return { connectTimeoutSeconds }
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

  // Issue #697 Chunk 4設計書「安全ガード（CLI配線）」節: canaryは実際に書き込み系
  // トランザクション（FOR UPDATEロック・トリガー発火）をtargetへ開くため、取り違え時の
  // リスクが読み取り専用layerより本質的に高い。既存の「--allow-skip-identityがあれば
  // identity無しでも実行できる」という一般ルール（このすぐ下のブロック）は、canaryに対しては
  // 一切の逃げ道を作らない（--allow-skip-identityを指定していても拒否する）。この判定は
  // 汎用ルールより先に行い、canary固有のより具体的なエラーメッセージを優先させる。
  if (layersResult.layers.includes('canary')) {
    if (!layersResult.layers.includes('identity')) {
      return {
        error:
          '--layers に canary が含まれる場合、identity layerの同時実行が必須です' +
          '（--allow-skip-identityでは回避できません。書き込みトランザクションを伴うcanaryは' +
          '取り違えリスクが読み取り専用layerより高いため、逃げ道を用意していません）。',
      }
    }
    if (parsed.allowSkipIdentity) {
      return {
        error:
          '--layers に canary が含まれる場合、--allow-skip-identity は指定できません' +
          '（canaryは常にidentity検証を必須とします）。',
      }
    }
  }

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

  const connectTimeoutResult = parseConnectTimeout(parsed.connectTimeoutRaw)
  if (connectTimeoutResult.error) return { error: connectTimeoutResult.error }

  return {
    sourceEnvironment: parsed.sourceEnvironment,
    targetEnvironment: parsed.targetEnvironment,
    sourceProvider: parsed.sourceProvider,
    targetProvider: parsed.targetProvider,
    layers: layersResult.layers,
    operationId: trimmedOperationId,
    chunkSize: chunkSizeResult.chunkSize,
    // Issue #697 Chunk 4: --fail-fast（真偽値、既定false=full-report mode）と
    // --connect-timeout（秒、既定DEFAULT_CONNECT_TIMEOUT_SECONDS）をverify.mjsへ伝える。
    failFast: parsed.failFast,
    connectTimeoutSeconds: connectTimeoutResult.connectTimeoutSeconds,
    sourceUrl,
    targetUrl,
  }
}
