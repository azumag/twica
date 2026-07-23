#!/usr/bin/env node

/**
 * Layer 6（runtime canary）実行本体 / Issue #697 Chunk 4
 *
 * 設計書（/private/tmp/.../scratchpad/chunk4-design.md、Fableレビュー2ラウンド承認済み）の
 * 「Layer 6: canary」節をそのまま実装する。既存レイヤー（layer-data.mjs/layer-invariants.mjs）と
 * 異なり、本layerは**target側のみ**に対して実行する（issue本文「targetへtransactionを開始」。
 * canaryの目的は「新DBが実運用処理を実行できるか」の検証であり、source（Supabase）は
 * cutover後も検証対象ではなく、書き込みトランザクションを開くのは不要なリスクを増やすだけ
 * のため）。
 *
 * ---
 * 実行モデル（設計書「実行モデル」節）:
 * `withRollbackOnlyTransaction`（snapshot.mjs、Chunk 4で追加）で開始した1つのトランザクション内で
 * 6チェックを逐次実行し、最後に必ずROLLBACKする。個々のチェックは`tx.savepoint()`
 * （postgres.jsのサブトランザクション機構）で隔離する: PostgreSQLは1つのSQLエラーで
 * トランザクション全体がabort状態（25P02: current transaction is aborted）になり、以降の
 * 全クエリが失敗するため、単純なtry/catchの継続では2つ目以降のチェックが軒並み
 * 「25P02」という無意味なエラーで潰れてしまう。SAVEPOINTを使うことで、1チェック内のSQL
 * エラーは当該savepointのROLLBACK（`ROLLBACK TO SAVEPOINT`）だけに閉じ込められ、
 * トランザクション全体は健全なまま後続チェックを継続できる（`CANARY_RUNTIME_ERROR`
 * fail findingへ変換。既存invariants layerの「invariantごとにtry/catch」と同じ
 * full-report哲学を、savepointという形でPostgreSQL側の制約に適合させたもの）。
 *
 * `canary-dashboard-reads`は書き込み前（fixture INSERT前）に実行する。read-only性を保つ
 * 意味は無い（後続チェックがどのみち書き込む）が、fixture混入前の「素の状態」でread経路を
 * 検証することに意味がある。
 *
 * fixtureのセットアップ（fixture streamers行 + cards行のINSERT）は「canary-gacha-rpcの
 * 前提データ」と位置付け、独自のsavepointで実行する。これが失敗した場合、依存する4チェック
 * （canary-gacha-rpc/canary-updated-at-trigger/canary-timestamp-shape/
 * canary-jsonb-array-parse。いずれもfixture streamers/cards行の存在を前提とする）を
 * `skipped: true` としてマークし、実行を試みない（設計書「fixture INSERT失敗時は...skipped
 * 扱いにする」）。fixtureセットアップ失敗自体を報告するfail findingは`canary-gacha-rpc`
 * チェックへ計上する（設計書の「fixture INSERT（canary-gacha-rpcの前提データ）」という
 * 位置付けに従う。この1件のfail findingがlayer全体のpass判定を正しくfalseにする）。
 *
 * `canary-rollback-verification`だけは他の5チェックと異なり、**トランザクションの外側**
 * （`withRollbackOnlyTransaction`が返った後、実際にROLLBACKが完了した状態）で実行する。
 * fixture識別子でSELECTして0件であることを確認する検証そのものが「トランザクション外から
 * 見て痕跡が残っていないこと」を検証する必要があるため、トランザクション内で検証しても
 * 意味がない（同一トランザクション内なら自分がINSERTした行は当然可視）。
 *
 * ---
 * fixture識別子の設計（設計書「fixture値の衝突回避」節）:
 * Twitch実IDは数字のみの文字列のため、`cutover-canary-<uuid>` という非数字プレフィックス値は
 * 実データと構造的に衝突しない。加えて、過去のcanary実行が何らかの理由で後始末に失敗し
 * 残骸が残っていた場合の衝突（operationIdのような固定値だけを使うと起こりうる）を避けるため、
 * 毎回のrun専用にuuidを生成し、識別子へ必ず含める（`buildFixtureIdentifiers`参照）。
 *
 * ---
 * redaction規律（設計書「canary findingのredaction規律」節、rev1レビューMajor-3対応）:
 * `canary-dashboard-reads`はrestore済みの実データ（本番運用ならば本物の配信者・視聴者データ）を
 * 読む。本ファイルが生成するfindingメッセージには**checkId・列名・型名（jsonb_typeof結果等）・
 * 件数・fixture識別子のみ**を含め、非fixture行の列値（expected/actualのdump含む）は
 * 一切埋め込まない。shape不一致は「列Xの型が期待(jsonb)/実際(text)」のようなメタ情報に
 * 限定する（`validateRowsShape`/`validateJsonbShape`の戻り値が値そのものを含まないことで
 * 構造的に担保している。呼び出し側がメッセージへ組み込むのも型名・列名のみ）。
 * この規律は tests/unit/db-cutover/layer-canary.test.ts で検証する。
 *
 * ---
 * canaryチェック一覧（設計書の表そのまま）:
 *   - canary-dashboard-reads: 主要read経路8種の実行と戻り形状検証
 *   - canary-gacha-rpc: execute_gacha_transaction（FOR UPDATE・2種の集計トリガー・冪等性）
 *   - canary-updated-at-trigger: update_updated_at_columnトリガーの発火確認
 *   - canary-timestamp-shape: timestamptz列のDB側表現（::text / to_jsonb()）の形式検証
 *   - canary-jsonb-array-parse: JSONB列（streamers）・TEXT[]列（users.twitch_scopes）の往復比較
 *   - canary-rollback-verification: ROLLBACK後の痕跡ゼロ検証（streamers/users/gacha_history/cards）
 *
 * SELECT FOR UPDATE関数のカバレッジについて: `execute_gacha_transaction`がFOR UPDATEを含む
 * ため、issue要求「SELECT FOR UPDATE function」の検証はcanary-gacha-rpcで充足する。
 * `activate_support_code`/`exchange_duplicate_card_for_stones`/`rename_card_pack`の
 * 追加canary化は見送る（YAGNI）: いずれも同じplpgsql実行基盤・同じロック機構を使い、
 * fixture要件（重複カード2枚の用意等）が重い割に検証価値が薄い（設計書「非スコープ」節）。
 */

'use strict'

import crypto from 'crypto'
import { createRequire } from 'module'
import { withRollbackOnlyTransaction } from './snapshot.mjs'

const require = createRequire(import.meta.url)
const core = require('../lib/db-migrate-core.js')

/** canaryチェックid一覧（report/CLI/テストが参照する順序どおり、設計書の表の順）。 */
export const CANARY_CHECK_IDS = [
  'canary-dashboard-reads',
  'canary-gacha-rpc',
  'canary-updated-at-trigger',
  'canary-timestamp-shape',
  'canary-jsonb-array-parse',
  'canary-rollback-verification',
]

/** fixture streamers/cards行に依存する4チェック（fixtureセットアップ失敗時にskipされる）。 */
const FIXTURE_DEPENDENT_CHECK_IDS = ['canary-gacha-rpc', 'canary-updated-at-trigger', 'canary-timestamp-shape', 'canary-jsonb-array-parse']

/** get_gacha_drop_statsのp_from_date probe用: 全期間を含む固定epoch値（実データに依存しない）。 */
const EPOCH_ISO = '1970-01-01T00:00:00Z'

/** targetの timestamptz `::text` キャストが取りうるPostgreSQLテキスト形式（設計書のregex仕様）。 */
const PG_TEXT_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/
/** `to_jsonb(timestamptz)` が取りうるISO 8601形式（T区切り、タイムゾーンオフセット付き）。 */
const ISO8601_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/

/**
 * fixture識別子をrun uuidから組み立てる純粋関数（DB接続なし、単体テスト対象）。
 * 設計書「fixture値の衝突回避」節の形式（`cutover-canary-<uuid>`/`cutover-canary:<uuid>`）を
 * そのまま実装する。streamers.twitch_user_id / users.twitch_user_id は同一文字列を使う
 * （別テーブルの独立したUNIQUE制約のため衝突しない。設計書の形式が単一である以上、
 * あえて`-streamer`/`-user`のようなsuffixで分ける変更は行わない）。
 * @param {string} runId `crypto.randomUUID()`等で生成された一意のuuid文字列
 */
export function buildFixtureIdentifiers(runId) {
  return {
    runId,
    streamerTwitchUserId: `cutover-canary-${runId}`,
    userTwitchUserId: `cutover-canary-${runId}`,
    eventId: `cutover-canary:${runId}`,
  }
}

/** severity='fail'・side='target'固定のfinding組み立てヘルパー（canaryはtarget限定のため）。 */
function canaryFail(code, message) {
  return { severity: 'fail', code, message, side: 'target' }
}

/**
 * 行配列の列shapeを検証する純粋関数（DB接続なし、単体テスト対象）。
 * redaction規律（ファイル冒頭コメント参照）を満たすため、戻り値には列名・型名のみを含み、
 * 実際の値は一切含めない。
 *
 * jsType='date' は特別扱い: postgres.jsのデフォルト型パーサ（fetch_types設定に関わらず
 * timestamp/timestamptzは常に`new Date(x)`、node_modules/postgres/cjs/src/types.js の
 * `date`エントリで確認済み）はtimestamptz列をJS `Date`インスタンスとして返す
 * （アプリ本体はclient.tsの`installIsoTimestampParsers`で文字列へ正規化しているが、
 * 本ツール自身の`postgres()`接続はこのカスタムパーサを適用しないプレーンな接続のため、
 * 本ツールが実際に観測する値の型に忠実な期待値にする）。
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {Array<{ name: string, jsType: 'string'|'number'|'boolean'|'date', nullable: boolean }>} columnSpecs
 * @returns {{ ok: true } | { ok: false, column: string, expectedType: string, actualType: string }}
 */
export function validateRowsShape(rows, columnSpecs) {
  for (const row of rows) {
    for (const spec of columnSpecs) {
      const value = row[spec.name]
      if (value === null || value === undefined) {
        if (!spec.nullable) {
          return { ok: false, column: spec.name, expectedType: spec.jsType, actualType: value === null ? 'null' : 'undefined' }
        }
        continue
      }
      if (spec.jsType === 'date') {
        if (!(value instanceof Date)) return { ok: false, column: spec.name, expectedType: 'date', actualType: typeof value }
        continue
      }
      if (typeof value !== spec.jsType) {
        return { ok: false, column: spec.name, expectedType: spec.jsType, actualType: typeof value }
      }
    }
  }
  return { ok: true }
}

/**
 * RPCが返すJSONB値のshapeを検証する純粋関数（DB接続なし、単体テスト対象）。
 * 配列（jsonb_agg由来）とオブジェクト（jsonb_build_object由来）の2種類のみを扱う
 * （本ツールが対象とするRPCは全てこのいずれかを返すため。設計書「非スコープ」の
 * YAGNI方針に従い、それ以外の形（プリミティブ直返し等）は扱わない）。
 * @param {unknown} value
 * @param {{ kind: 'array' } | { kind: 'object', fields?: Record<string, 'string'|'number'|'boolean'|'array'> }} spec
 */
export function validateJsonbShape(value, spec) {
  if (value === null || value === undefined) {
    return { ok: false, actualType: value === null ? 'null' : 'undefined' }
  }
  if (spec.kind === 'array') {
    if (!Array.isArray(value)) return { ok: false, actualType: typeof value }
    return { ok: true }
  }
  if (spec.kind === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, actualType: Array.isArray(value) ? 'array' : typeof value }
    }
    if (spec.fields) {
      for (const [field, expectedKind] of Object.entries(spec.fields)) {
        if (!(field in value)) return { ok: false, missingField: field }
        const fieldValue = /** @type {Record<string, unknown>} */ (value)[field]
        if (expectedKind === 'array') {
          if (!Array.isArray(fieldValue)) return { ok: false, field, expectedKind, actualType: typeof fieldValue }
        } else if (typeof fieldValue !== expectedKind) {
          return { ok: false, field, expectedKind, actualType: typeof fieldValue }
        }
      }
    }
    return { ok: true }
  }
  throw new Error(`validateJsonbShape: unknown spec.kind ${JSON.stringify(spec.kind)}`)
}

/**
 * shape検証結果（validateRowsShape/validateJsonbShapeの戻り値）をredaction規律に沿った
 * 1行メッセージへ整形する。列名・型名のみを含み、実際の値は含めない。
 * @param {string} readId
 * @param {ReturnType<typeof validateRowsShape> | ReturnType<typeof validateJsonbShape>} result
 */
function formatShapeMismatch(readId, result) {
  if ('missingField' in result) {
    return `canary-dashboard-reads/${readId}: JSONB結果にフィールド '${result.missingField}' がありません。`
  }
  if ('column' in result) {
    return `canary-dashboard-reads/${readId}: 列 '${result.column}' の型が期待(${result.expectedType})と異なります(実際の型: ${result.actualType})。`
  }
  if ('field' in result) {
    return `canary-dashboard-reads/${readId}: フィールド '${result.field}' の型が期待(${result.expectedKind})と異なります(実際の型: ${result.actualType})。`
  }
  return `canary-dashboard-reads/${readId}: 戻り値の形状が期待と異なります(実際の型: ${'actualType' in result ? result.actualType : 'unknown'})。`
}

/**
 * canary-dashboard-reads が実行する8つのread定義。design書の表と1対1対応する。
 * 各`run`はpostgres.jsが渡すsavepointスコープのsqlタグ関数（`tx.savepoint(name, fn)`の`fn`が
 * 受け取る引数そのもの）を受け取り、validateRowsShape/validateJsonbShapeの戻り値をそのまま
 * 返す（DB接続を要するためこのファイル内でのみ完結させ、shape検証ロジック自体は上記の
 * 純粋関数へ委譲する）。呼び出し側（checkDashboardReads）が必ずこの`run`自体を
 * `tx.savepoint(name, run)`の`fn`として渡すことで、savepointスコープのsqlを正しく使わせる
 * （外側の`tx`をクロージャで捕まえて使うと、postgres.jsが内部でscope単位に保持する
 * クエリキュー/uncaughtError追跡の対象がずれるため、必ず savepoint が渡す引数を使う）。
 * @param {{ probeUuid: string, probeText: string }} probe
 */
function buildDashboardReads(probe) {
  return [
    {
      // getStreamerDataPg相当（src/lib/dashboard-data.ts）: streamers LEFT JOIN cards。
      id: 'streamers-cards-join',
      run: async (tx) => {
        const rows = await tx`
          select s.id as streamer_id, s.twitch_user_id, s.is_active as streamer_is_active,
                 c.id as card_id, c.is_active as card_is_active, c.drop_rate as card_drop_rate
          from streamers s
          left join cards c on c.streamer_id = s.id
          order by s.created_at desc
          limit 5
        `
        return validateRowsShape(rows, [
          { name: 'streamer_id', jsType: 'string', nullable: false },
          { name: 'twitch_user_id', jsType: 'string', nullable: false },
          { name: 'streamer_is_active', jsType: 'boolean', nullable: true },
          { name: 'card_id', jsType: 'string', nullable: true },
          { name: 'card_is_active', jsType: 'boolean', nullable: true },
          // numeric(5,4)はpostgres.jsのデフォルト型パーサ対象外(bigint等と同じ精度保持のため
          // 文字列で返る。canonicalize.mjs冒頭コメント参照)。
          { name: 'card_drop_rate', jsType: 'string', nullable: true },
        ])
      },
    },
    {
      // 履歴系相当（getGachaHistoryForUserPg等）: gacha_history LEFT JOIN cards LEFT JOIN streamers。
      id: 'gacha-history-cards-streamers-join',
      run: async (tx) => {
        const rows = await tx`
          select gh.id as history_id, gh.event_id, gh.redeemed_at,
                 c.id as card_id, c.name as card_name,
                 s.id as streamer_id, s.twitch_display_name as streamer_display_name
          from gacha_history gh
          left join cards c on c.id = gh.card_id
          left join streamers s on s.id = gh.streamer_id
          order by gh.redeemed_at desc
          limit 5
        `
        return validateRowsShape(rows, [
          { name: 'history_id', jsType: 'string', nullable: false },
          { name: 'event_id', jsType: 'string', nullable: true },
          { name: 'redeemed_at', jsType: 'date', nullable: true },
          { name: 'card_id', jsType: 'string', nullable: true },
          { name: 'card_name', jsType: 'string', nullable: true },
          { name: 'streamer_id', jsType: 'string', nullable: true },
          { name: 'streamer_display_name', jsType: 'string', nullable: true },
        ])
      },
    },
    {
      id: 'rpc-get_user_card_counts',
      run: async (tx) => {
        const rows = await tx`select get_user_card_counts(p_twitch_user_id => ${probe.probeText}) as result`
        return validateJsonbShape(rows[0]?.result, { kind: 'array' })
      },
    },
    {
      id: 'rpc-get_gacha_drop_stats',
      run: async (tx) => {
        const rows = await tx`select get_gacha_drop_stats(p_streamer_id => ${probe.probeUuid}::uuid, p_from_date => ${EPOCH_ISO}::timestamptz) as result`
        return validateJsonbShape(rows[0]?.result, { kind: 'object', fields: { total_draws: 'number', card_stats: 'array', rarity_stats: 'array' } })
      },
    },
    {
      id: 'rpc-get_channel_point_usage_stats',
      run: async (tx) => {
        const rows = await tx`select get_channel_point_usage_stats(p_streamer_id => ${probe.probeUuid}::uuid) as result`
        return validateJsonbShape(rows[0]?.result, { kind: 'object', fields: { total_points: 'number', ranking: 'array' } })
      },
    },
    {
      id: 'rpc-get_card_owner_stats',
      run: async (tx) => {
        const rows = await tx`select get_card_owner_stats(p_streamer_id => ${probe.probeUuid}::uuid) as result`
        return validateJsonbShape(rows[0]?.result, { kind: 'object', fields: { card_stats: 'array' } })
      },
    },
    {
      id: 'rpc-get_issued_card_counts',
      run: async (tx) => {
        // 空配列リテラル '{}'::uuid[] はこの関数内で完結する固定値（外部入力を経由しない）
        // であり、バインドパラメータではなくSQL文字列へ直接埋め込んでも安全。JS配列を
        // バインドパラメータとして渡す方式は、postgres.jsの配列バインド解決の複雑さを
        // 避けるため使わない（src/lib/services/gacha.tsのgetIssuedCounts実装が
        // `string_to_array(...)::uuid[]`という迂回を採っているのと同じ理由の対策を、
        // 固定の空配列リテラルというさらに単純な形で踏襲する）。
        const rows = await tx`select get_issued_card_counts(p_card_ids => '{}'::uuid[]) as result`
        return validateJsonbShape(rows[0]?.result, { kind: 'object' })
      },
    },
    {
      id: 'rpc-get_gacha_users_for_streamer',
      run: async (tx) => {
        const rows = await tx`select get_gacha_users_for_streamer(p_streamer_id => ${probe.probeUuid}::uuid) as result`
        return validateJsonbShape(rows[0]?.result, { kind: 'object', fields: { users: 'array', total: 'number' } })
      },
    },
  ]
}

/**
 * canary-dashboard-reads チェック本体。8つのreadをそれぞれ独立したsavepointで実行する
 * （8つのうち1つがSQLエラーを起こしても、残り7つの診断情報を失わないため。トップレベルの
 * SAVEPOINT隔離と同じ考え方を、1チェック内の複数read間にも適用する。呼び出し側
 * （runCheck）が既にこのチェック全体を1つのsavepointで囲んでいるが、それとは別に
 * read単位でも囲むことで粒度の細かい診断を可能にする）。
 * @param {import('postgres').Sql} tx savepointスコープのtx（呼び出し元のrunCheckが渡す）
 * @param {(text: string) => string} redactError
 */
async function checkDashboardReads(tx, redactError) {
  const probe = { probeUuid: crypto.randomUUID(), probeText: 'cutover-canary-dashboard-probe' }
  const reads = buildDashboardReads(probe)
  const findings = []

  for (const read of reads) {
    let savepointResult
    try {
      savepointResult = { ok: true, result: await tx.savepoint(`dashboard_reads_${read.id}`.replace(/[^a-zA-Z0-9_]/g, '_'), read.run) }
    } catch (error) {
      savepointResult = { ok: false, error }
    }

    if (!savepointResult.ok) {
      const message = redactError(savepointResult.error instanceof Error ? savepointResult.error.message : String(savepointResult.error))
      findings.push(canaryFail('CANARY_DASHBOARD_READ_ERROR', `canary-dashboard-reads/${read.id}: 実行中にエラーが発生しました: ${message}`))
      continue
    }
    if (!savepointResult.result.ok) {
      findings.push(canaryFail('CANARY_DASHBOARD_READ_SHAPE_MISMATCH', formatShapeMismatch(read.id, savepointResult.result)))
    }
  }

  return { pass: findings.length === 0, findings }
}

/**
 * fixture streamers行 + cards行をINSERTする（canary-gacha-rpcの前提データ、ファイル冒頭
 * コメント参照）。streamers行のJSONB列（gacha_sound_rules/custom_rarities/card_pack_names）に
 * 既知値を入れておく理由: canary-jsonb-array-parseがこれらの往復比較に使う
 * （fixtureセットアップを1箇所に集約し、依存する4チェックすべてがここで作られた行を
 * 参照する設計。設計書「fixture INSERT（canary-gacha-rpcの前提データ）」）。
 *
 * updated_at/created_atを明示的に過去時刻（`NOW() - interval '1 hour'`）で挿入する理由:
 * `update_updated_at_column()`トリガーが使う`NOW()`（=`transaction_timestamp()`）は
 * 同一トランザクション内で不変のため、DEFAULT値（`NOW()`）のまま挿入すると、後続の
 * canary-updated-at-triggerでのUPDATE後も`updated_at`が全く同じ値のままになり
 * 「変わったこと」を検証できない。`NOW() - interval '1 hour'`は「トランザクション開始時刻
 * より1時間前」という、トランザクション内で不変な基準からのオフセット値になるため、
 * 後続のUPDATEが同じ（不変の）`NOW()`をセットしても、insert時の値より確実に大きくなる。
 *
 * JSONB値をJSON.stringify()せずJS配列/オブジェクトのまま渡す理由（重要、実機検証で判明。
 * Fableレビューで機構説明を訂正済み）:
 * postgres.jsの拡張クエリプロトコルは、Parse送信後にサーバーへDescribeを要求し、
 * サーバーが返す`ParameterDescription`メッセージで各パラメータの型OIDを通知される
 * （`$1::jsonb`のようなSQL側キャストは、この時点でサーバーのパーサ自身がパラメータ型を
 * jsonb〔OID 3802〕と解決する根拠になる。postgres.js側がSQLテキストを見て`::jsonb`という
 * 文字列パターンを判定しているわけではない）。postgres.jsはBind時、このサーバー由来の型OIDを
 * キーに`options.serializers[oid]`から対応するシリアライザ関数を選び、パラメータ値へ適用する
 * （`node_modules/postgres/cjs/src/connection.js`: `ParameterDescription`がOIDを
 * `query.statement.types[i]`へ格納し〔633行目付近〕、`Bind`送信時に`type = types[i]`で
 * それを引いて`options.serializers[type](x)`を呼ぶ〔959行目付近〕。jsonb/json用の
 * シリアライザは`JSON.stringify(x)`、`node_modules/postgres/cjs/src/types.js`の`json`型
 * エントリで定義）。呼び出し側が事前に`JSON.stringify()`した文字列を渡すと、この
 * サーバー主導のシリアライザがその文字列へさらに`JSON.stringify()`を適用し、二重エンコードに
 * なる（結果、`jsonb_typeof()`が`'array'`ではなく`'string'`になり、
 * `streamers_card_pack_names_valid`等のCHECK制約に違反してINSERT自体が失敗する。
 * Docker実機テストで実際に踏んで確認済みの罠）。JS配列/オブジェクトをそのまま渡すことで、
 * postgres.js自身のシリアライズ1回のみで正しくjsonbへ変換される。
 * @param {import('postgres').Sql} tx
 * @param {{ streamerTwitchUserId: string }} identifiers
 */
async function setupFixtures(tx, identifiers) {
  const streamerId = crypto.randomUUID()
  const cardId = crypto.randomUUID()
  const gachaSoundRules = [{ scope: 'all', sound_url: 'https://example.invalid/cutover-canary.mp3' }]
  const customRarities = ['cutover-canary-rarity']
  const cardPackNames = ['cutover-canary-pack']

  await tx`
    insert into streamers (
      id, twitch_user_id, twitch_username, twitch_display_name, is_active,
      gacha_sound_rules, custom_rarities, card_pack_names, created_at, updated_at
    ) values (
      ${streamerId}::uuid, ${identifiers.streamerTwitchUserId}, 'cutover-canary', 'Cutover Canary', true,
      ${gachaSoundRules}::jsonb, ${customRarities}::jsonb, ${cardPackNames}::jsonb,
      NOW() - interval '1 hour', NOW() - interval '1 hour'
    )
  `

  // is_active=true・max_issuance_count=NULL固定（設計書「fixture streamer行・cards行」）:
  // 無制限発行のカードにすることで、canary-gacha-rpcの2回目呼び出し（冪等性チェック）が
  // 発行上限にひっかかって余計な分岐へ入るのを避ける。
  await tx`
    insert into cards (id, streamer_id, name, is_active, max_issuance_count)
    values (${cardId}::uuid, ${streamerId}::uuid, 'cutover-canary-card', true, null)
  `

  return { streamerId, cardId, gachaSoundRules, customRarities, cardPackNames }
}

/**
 * canary-gacha-rpc チェック本体: execute_gacha_transaction を実際に2回呼び出し、
 * 戻り値・gacha_history/users/user_cards行の作成・2種の集計トリガー発火・冪等性を検証する。
 *
 * p_reward_cost=100（正値固定）について（設計書rev1レビューMinor-1対応、重要）:
 * `refresh_channel_point_usage_stat`（00039）は`reward_cost > 0`の行のみ集計するため、
 * DEFAULT NULLのまま呼び出すとchannel_point_usage_statsに行が作られず、後続の
 * トリガー発火検証が健全なDBに対してすら偽陽性でfailする。正値を明示することでこの罠を回避する。
 * @param {import('postgres').Sql} tx
 * @param {{ streamerId: string, cardId: string, userTwitchUserId: string, eventId: string }} ctx
 */
async function checkGachaRpc(tx, ctx) {
  const findings = []
  const { streamerId, cardId, userTwitchUserId, eventId } = ctx

  const callRpc = () => tx`
    select execute_gacha_transaction(
      p_event_id => ${eventId},
      p_user_twitch_id => ${userTwitchUserId},
      p_user_twitch_username => ${'Cutover Canary Viewer'},
      p_card_id => ${cardId}::uuid,
      p_streamer_id => ${streamerId}::uuid,
      p_reward_cost => ${100}::integer,
      p_reward_id => ${null}
    ) as result
  `

  const firstRows = await callRpc()
  const firstResult = firstRows[0]?.result
  if (!firstResult || typeof firstResult !== 'object') {
    findings.push(canaryFail('CANARY_GACHA_RPC_UNEXPECTED_RESULT', `execute_gacha_transactionの1回目呼び出しの戻り値がJSONBオブジェクトではありませんでした(実際の型: ${typeof firstResult})。`))
    return { pass: false, findings }
  }
  if (firstResult.is_duplicate !== false) {
    findings.push(canaryFail('CANARY_GACHA_RPC_UNEXPECTED_RESULT', `1回目呼び出しの is_duplicate が期待(false)と異なります(実際の型: ${typeof firstResult.is_duplicate})。`))
  }
  if (firstResult.limit_reached !== false) {
    findings.push(canaryFail('CANARY_GACHA_RPC_UNEXPECTED_RESULT', `1回目呼び出しの limit_reached が期待(false)と異なります(実際の型: ${typeof firstResult.limit_reached})。`))
  }
  if (typeof firstResult.history_id !== 'string') {
    findings.push(canaryFail('CANARY_GACHA_RPC_UNEXPECTED_RESULT', `1回目呼び出しの history_id がuuid文字列ではありませんでした(実際の型: ${typeof firstResult.history_id})。`))
  }

  const historyRows = await tx`select id from gacha_history where event_id = ${eventId}`
  if (historyRows.length !== 1) {
    findings.push(canaryFail('CANARY_GACHA_RPC_HISTORY_ROW_MISSING', `gacha_history行が期待通り作成されていません(件数=${historyRows.length})。`))
  }

  const userRows = await tx`select id from users where twitch_user_id = ${userTwitchUserId}`
  if (userRows.length !== 1) {
    findings.push(canaryFail('CANARY_GACHA_RPC_USER_ROW_MISSING', `RPCによるusers行の自動作成(ON CONFLICT DO NOTHING)が確認できません(件数=${userRows.length})。`))
  }
  const userId = userRows[0]?.id

  if (userId) {
    const userCardRows = await tx`select count(*)::int as cnt from user_cards where user_id = ${userId}::uuid and card_id = ${cardId}::uuid`
    if (Number(userCardRows[0]?.cnt) !== 1) {
      findings.push(canaryFail('CANARY_GACHA_RPC_USER_CARDS_ROW_MISSING', `user_cards行が期待通り作成されていません(件数=${userCardRows[0]?.cnt})。`))
    }
  }

  // トリガー1: trg_sync_channel_point_usage_stat（gacha_history INSERT起因）。
  const cpuRows = await tx`
    select total_points, redemption_count
    from channel_point_usage_stats
    where streamer_id = ${streamerId}::uuid and user_twitch_id = ${userTwitchUserId}
  `
  if (cpuRows.length !== 1) {
    findings.push(canaryFail('CANARY_GACHA_RPC_TRIGGER_CHANNEL_POINT_USAGE_MISSING', `channel_point_usage_statsに集計行が作成されていません(件数=${cpuRows.length})。trg_sync_channel_point_usage_statトリガー不発の疑い。`))
  } else if (Number(cpuRows[0].total_points) !== 100 || Number(cpuRows[0].redemption_count) !== 1) {
    findings.push(canaryFail('CANARY_GACHA_RPC_TRIGGER_CHANNEL_POINT_USAGE_MISMATCH', 'channel_point_usage_statsの集計値(total_points/redemption_count)が期待と異なります。'))
  }

  // トリガー2: trg_sync_card_owner_stat（user_cards INSERT起因）。
  const cosRows = await tx`
    select owned_count
    from card_owner_stats
    where streamer_id = ${streamerId}::uuid and card_id = ${cardId}::uuid and user_twitch_id = ${userTwitchUserId}
  `
  if (cosRows.length !== 1) {
    findings.push(canaryFail('CANARY_GACHA_RPC_TRIGGER_CARD_OWNER_MISSING', `card_owner_statsに集計行が作成されていません(件数=${cosRows.length})。trg_sync_card_owner_statトリガー不発の疑い。`))
  } else if (Number(cosRows[0].owned_count) !== 1) {
    findings.push(canaryFail('CANARY_GACHA_RPC_TRIGGER_CARD_OWNER_MISMATCH', 'card_owner_statsの集計値(owned_count)が期待と異なります。'))
  }

  // 冪等性: 同一event_idでの2回目呼び出しはON CONFLICT (event_id) DO NOTHINGによりis_duplicate=trueを
  // 返す（自身の未commit挿入が同一トランザクション内で可視であるため、コミットを待たずに検知できる）。
  const secondRows = await callRpc()
  const secondResult = secondRows[0]?.result
  if (!secondResult || secondResult.is_duplicate !== true) {
    findings.push(canaryFail('CANARY_GACHA_RPC_IDEMPOTENCY_FAILED', `同一event_idでの2回目呼び出しでis_duplicate=trueが返りませんでした(実際の型: ${typeof secondResult?.is_duplicate})。`))
  }

  return { pass: !findings.some((f) => f.severity === 'fail'), findings }
}

/**
 * canary-updated-at-trigger チェック本体: fixture streamers行をUPDATEし、`updated_at`が
 * INSERT時の明示的な過去値より進むこと（`update_updated_at_column`トリガー発火）を検証する。
 * cards/users等の同型トリガーは全て同一関数（`update_updated_at_column`）が使われているため、
 * 代表して streamers 1つを検証すれば十分（設計書「cards/users等の同型トリガーは同一関数の
 * ため代表1つで足りる」）。
 * @param {import('postgres').Sql} tx
 * @param {{ streamerId: string }} ctx
 */
async function checkUpdatedAtTrigger(tx, ctx) {
  const beforeRows = await tx`select updated_at from streamers where id = ${ctx.streamerId}::uuid`
  if (beforeRows.length !== 1) {
    return { pass: false, findings: [canaryFail('CANARY_UPDATED_AT_TRIGGER_FIXTURE_MISSING', `fixture streamers行が見つかりません(件数=${beforeRows.length})。`)] }
  }
  const beforeUpdatedAt = beforeRows[0].updated_at

  await tx`update streamers set twitch_display_name = ${'Cutover Canary (updated)'} where id = ${ctx.streamerId}::uuid`

  const afterRows = await tx`select updated_at from streamers where id = ${ctx.streamerId}::uuid`
  const afterUpdatedAt = afterRows[0]?.updated_at

  const findings = []
  if (!(afterUpdatedAt instanceof Date) || !(beforeUpdatedAt instanceof Date) || !(afterUpdatedAt > beforeUpdatedAt)) {
    findings.push(
      canaryFail(
        'CANARY_UPDATED_AT_TRIGGER_NOT_ADVANCED',
        'UPDATE後もupdated_atが挿入時刻(明示的な過去値)より進みませんでした(update_updated_at_columnトリガー不発の疑い)。'
      )
    )
  }

  return { pass: findings.length === 0, findings }
}

/**
 * canary-timestamp-shape チェック本体: fixture streamers行の created_at/updated_at を対象に、
 * `::text`キャストがPostgreSQLテキスト形式に、`to_jsonb()`経由がISO 8601形式に一致することを
 * SQL側完結で検証する。
 *
 * fixture streamers行（gacha_historyではなく）を対象にする理由: streamers行はfixture
 * セットアップ（setupFixtures）が成功した時点で必ず存在し、canary-gacha-rpcの成否に
 * 依存しない。4つの依存チェック（gacha-rpc/updated-at/timestamp/jsonb）はいずれもsavepointで
 * 独立に実行されるため、canary-timestamp-shapeがcanary-gacha-rpcの副作用（gacha_history行）に
 * 依存しない設計にすることで、savepoint隔離の効果を最大化する（1チェックの失敗が他へ波及しない）。
 * created_at/updated_atはgacha_history.redeemed_atと同じtimestamptz型のため、DB側の表現形式を
 * 検証するという目的には対等に使える（設計書「fixture行のredeemed_at等を利用」の「等」に
 * 相当する解釈。この判断は最終報告で明示する）。
 *
 * クライアント側パーサ（アプリのinstallIsoTimestampParsers）の検証は本canaryの守備範囲外
 * （設計書「アプリ単体テストの守備範囲」）。
 * @param {import('postgres').Sql} tx
 * @param {{ streamerId: string }} ctx
 */
async function checkTimestampShape(tx, ctx) {
  const rows = await tx`
    select
      created_at::text as created_at_text,
      updated_at::text as updated_at_text,
      to_jsonb(created_at) as created_at_json,
      to_jsonb(updated_at) as updated_at_json
    from streamers where id = ${ctx.streamerId}::uuid
  `
  if (rows.length !== 1) {
    return { pass: false, findings: [canaryFail('CANARY_TIMESTAMP_SHAPE_FIXTURE_MISSING', `fixture streamers行が見つかりません(件数=${rows.length})。`)] }
  }
  const row = rows[0]
  const findings = []

  for (const column of ['created_at', 'updated_at']) {
    const textValue = row[`${column}_text`]
    if (typeof textValue !== 'string' || !PG_TEXT_TIMESTAMP_REGEX.test(textValue)) {
      findings.push(canaryFail('CANARY_TIMESTAMP_SHAPE_TEXT_MISMATCH', `${column}::text がPostgreSQLテキスト形式に一致しません(列: ${column}, 実際の型: ${typeof textValue})。`))
    }
    const jsonValue = row[`${column}_json`]
    if (typeof jsonValue !== 'string' || !ISO8601_TIMESTAMP_REGEX.test(jsonValue)) {
      findings.push(canaryFail('CANARY_TIMESTAMP_SHAPE_JSON_MISMATCH', `to_jsonb(${column}) がISO 8601形式に一致しません(列: ${column}, 実際の型: ${typeof jsonValue})。`))
    }
  }

  return { pass: findings.length === 0, findings }
}

/** JSONB列1本分のjsonb_typeof/往復比較findingを組み立てる内部ヘルパー。 */
function evaluateJsonbColumnResult(findings, columnName, row) {
  if (!row) {
    findings.push(canaryFail('CANARY_JSONB_ARRAY_PARSE_FIXTURE_MISSING', `${columnName}: fixture streamers行が見つかりません。`))
    return
  }
  if (row.typeof !== 'array') {
    findings.push(canaryFail('CANARY_JSONB_ARRAY_PARSE_TYPEOF_MISMATCH', `${columnName}: jsonb_typeof()の結果が期待(array)と異なります(実際: ${row.typeof})。`))
  }
  if (row.round_trip_equal !== true) {
    findings.push(canaryFail('CANARY_JSONB_ARRAY_PARSE_ROUND_TRIP_MISMATCH', `${columnName}: 挿入値とSELECT値のjsonb等価比較が一致しませんでした。`))
  }
}

/**
 * canary-jsonb-array-parse チェック本体: streamers の3つのJSONB列（gacha_sound_rules/
 * custom_rarities/card_pack_names）を jsonb_typeof + 往復比較で検証し、続けて
 * users.twitch_scopes（TEXT[]）を明示UPDATE + cardinality() + 往復比較で検証する。
 *
 * TEXT[]をRPCが作成したusers行に対してUPDATEする理由（設計書rev1レビューMinor-2対応）:
 * DEFAULT `'{}'`のままだと`array_length('{}',1)`がNULLを返す罠があるため、非空の既知値へ
 * 明示UPDATEすることでTEXT[]書き込み経路も同時に検証する（`cardinality()`は空配列に対しても
 * 0を返しNULLの罠が無いため、要素数確認にはこちらを使う）。
 * @param {import('postgres').Sql} tx
 * @param {{ streamerId: string, userTwitchUserId: string, gachaSoundRules: unknown, customRarities: unknown, cardPackNames: unknown }} ctx
 */
async function checkJsonbArrayParse(tx, ctx) {
  const findings = []
  const { streamerId, userTwitchUserId, gachaSoundRules, customRarities, cardPackNames } = ctx

  // JSON.stringify()を挟まずJS配列をそのまま渡す理由はsetupFixturesのコメント参照
  // （サーバーがDescribeで返すパラメータ型OID〔`::jsonb`キャストにより3802〕に基づき
  // postgres.jsがJSON.stringify()シリアライザを自動適用するため、事前にstringify済みの
  // 値を渡すと二重エンコードになる。機構の詳細はsetupFixtures参照）。
  const soundRulesRows = await tx`
    select jsonb_typeof(gacha_sound_rules) as typeof, (gacha_sound_rules = ${gachaSoundRules}::jsonb) as round_trip_equal
    from streamers where id = ${streamerId}::uuid
  `
  evaluateJsonbColumnResult(findings, 'gacha_sound_rules', soundRulesRows[0])

  const customRaritiesRows = await tx`
    select jsonb_typeof(custom_rarities) as typeof, (custom_rarities = ${customRarities}::jsonb) as round_trip_equal
    from streamers where id = ${streamerId}::uuid
  `
  evaluateJsonbColumnResult(findings, 'custom_rarities', customRaritiesRows[0])

  const cardPackNamesRows = await tx`
    select jsonb_typeof(card_pack_names) as typeof, (card_pack_names = ${cardPackNames}::jsonb) as round_trip_equal
    from streamers where id = ${streamerId}::uuid
  `
  evaluateJsonbColumnResult(findings, 'card_pack_names', cardPackNamesRows[0])

  const knownScopes = ['channel:read:redemptions', 'user:read:email']
  const updateRows = await tx`
    update users set twitch_scopes = ${knownScopes}
    where twitch_user_id = ${userTwitchUserId}
    returning cardinality(twitch_scopes) as scope_count, (twitch_scopes = ${knownScopes}) as round_trip_equal
  `
  if (updateRows.length !== 1) {
    findings.push(
      canaryFail(
        'CANARY_JSONB_ARRAY_PARSE_USER_ROW_MISSING',
        `twitch_scopes往復比較の対象となるfixture users行が見つかりません(件数=${updateRows.length}。canary-gacha-rpcが未実行/失敗した可能性)。`
      )
    )
  } else {
    const { scope_count: scopeCount, round_trip_equal: roundTripEqual } = updateRows[0]
    if (Number(scopeCount) !== knownScopes.length) {
      findings.push(canaryFail('CANARY_JSONB_ARRAY_PARSE_TEXT_ARRAY_CARDINALITY_MISMATCH', `twitch_scopesのcardinality()が期待件数(${knownScopes.length})と一致しません(実際の件数: ${scopeCount})。`))
    }
    if (roundTripEqual !== true) {
      findings.push(canaryFail('CANARY_JSONB_ARRAY_PARSE_TEXT_ARRAY_ROUND_TRIP_MISMATCH', 'twitch_scopesの往復比較(UPDATE直後のSELECT一致)が一致しませんでした。'))
    }
  }

  return { pass: !findings.some((f) => f.severity === 'fail'), findings }
}

/**
 * canary-rollback-verification チェック本体: ROLLBACK完了後、トランザクション**外**から
 * fixture識別子でSELECTし、streamers/users/gacha_history/cardsの全てで0件であることを
 * 確認する（設計書「rollback後の痕跡ゼロ検証はstreamers/users/gacha_history/cards全部」）。
 *
 * cardIdがnull（fixtureセットアップ自体が失敗した場合）でも安全に動作する: `id = NULL::uuid`は
 * 常にUNKNOWN（該当0件）と評価されるため、特別分岐は不要（このcanaryが検証したいのは
 * あくまで「トランザクション外から見て痕跡が無いこと」であり、fixtureが最初から
 * 存在しなければ痕跡も無くて当然、というトリビアルなケースとして自然に成立する）。
 *
 * fail時の後始末（設計書「fail時の後始末」節）: fixture streamers行のDELETEが
 * cards/gacha_history等へON DELETE CASCADEで届くため、finding messageに復旧手順を明記する
 * （streamers/gacha_historyそれぞれ独立の外部キーでcards/streamersを参照しているため、
 * 実際にはstreamers行を消せばcards・gacha_historyとも連鎖的に消える。usersは
 * user_cards経由でのみcascadeするため、streamers行の削除だけでは消えず別途DELETEが必要）。
 * @param {import('postgres').Sql} sql withRollbackOnlyTransactionが返った後のトップレベル接続
 *   （トランザクションスコープの`tx`ではない。ファイル冒頭コメント参照）
 * @param {{ streamerTwitchUserId: string, userTwitchUserId: string, eventId: string, cardId: string | null }} identifiers
 */
export async function verifyRollbackTraceless(sql, identifiers) {
  const findings = []
  const { streamerTwitchUserId, userTwitchUserId, eventId, cardId } = identifiers

  const streamerRows = await sql`select id from streamers where twitch_user_id = ${streamerTwitchUserId}`
  if (streamerRows.length > 0) {
    findings.push(
      canaryFail(
        'CANARY_ROLLBACK_TRACE_STREAMERS',
        `rollback後もstreamers行が残存しています(件数=${streamerRows.length})。復旧: fixture streamers行をtwitch_user_id(cutover-canary-<uuid>形式)で特定しDELETEすれば、cards/gacha_historyへON DELETE CASCADEで連鎖的に除去できます(usersはuser_cards経由でのみcascadeするため別途DELETEが必要、runbook参照)。`
      )
    )
  }

  const userRows = await sql`select id from users where twitch_user_id = ${userTwitchUserId}`
  if (userRows.length > 0) {
    findings.push(canaryFail('CANARY_ROLLBACK_TRACE_USERS', `rollback後もusers行が残存しています(件数=${userRows.length})。復旧: twitch_user_id(cutover-canary-<uuid>形式)で特定しDELETEしてください(user_cardsへON DELETE CASCADEで連鎖します)。`))
  }

  const historyRows = await sql`select id from gacha_history where event_id = ${eventId}`
  if (historyRows.length > 0) {
    findings.push(canaryFail('CANARY_ROLLBACK_TRACE_GACHA_HISTORY', `rollback後もgacha_history行が残存しています(件数=${historyRows.length})。復旧: event_id(cutover-canary:<uuid>形式)で特定しDELETEしてください。`))
  }

  const cardRows = await sql`select id from cards where id = ${cardId}::uuid`
  if (cardRows.length > 0) {
    findings.push(canaryFail('CANARY_ROLLBACK_TRACE_CARDS', `rollback後もcards行(fixture streamer由来)が残存しています(件数=${cardRows.length})。復旧: 対応するfixture streamers行をDELETEすれば連鎖的に除去できます。`))
  }

  return findings
}

/**
 * 1チェックをsavepointで実行し、結果を統一形状（{id, pass, skipped, findings, durationMs}）へ
 * まとめる内部ヘルパー。savepoint内で捕捉されなかった例外（`fn`自体が投げた例外。savepointは
 * 例外時に自動でROLLBACK TO SAVEPOINTしてから再throwする、node_modules/postgres/cjs/src/index.js
 * のscope()実装で確認済み）は`CANARY_RUNTIME_ERROR`のfail findingへ変換し、このcheckのみ
 * failとして扱う（後続チェックは呼び出し元のループで継続される。ファイル冒頭コメント
 * 「実行モデル」参照）。
 *
 * onCanaryCheckedの`pass`は常にboolean（nullにはならない）: `skipped:true`の場合も
 * 「検証できなかった」ことを`pass:false`で明示する（設計判断。「未評価」を意味する
 * `null`を許容すると、呼び出し側がnullish判定を怠った場合に「skipされたチェックが
 * 誤ってpass扱いされる」事故に繋がりうるため、skip時も必ずfalseを渡す一貫性を優先する）。
 * @param {import('postgres').Sql} tx
 * @param {string} checkId
 * @param {(text: string) => string} redactError
 * @param {((info: { checkId: string, pass: boolean, skipped: boolean, durationMs: number }) => void) | undefined} onCanaryChecked
 * @param {(spTx: import('postgres').Sql) => Promise<{ pass: boolean, findings: unknown[] }>} fn
 */
async function runCheck(tx, checkId, redactError, onCanaryChecked, fn) {
  const startedAt = Date.now()
  let outcome
  try {
    const result = await tx.savepoint(checkId.replace(/[^a-zA-Z0-9_]/g, '_'), fn)
    outcome = { id: checkId, pass: result.pass, skipped: false, findings: result.findings, durationMs: Date.now() - startedAt }
  } catch (error) {
    const message = redactError(error instanceof Error ? error.message : String(error))
    outcome = {
      id: checkId,
      pass: false,
      skipped: false,
      findings: [canaryFail('CANARY_RUNTIME_ERROR', `${checkId}: 実行中にエラーが発生しました: ${message}`)],
      durationMs: Date.now() - startedAt,
    }
  }
  if (onCanaryChecked) onCanaryChecked({ checkId, pass: outcome.pass, skipped: outcome.skipped, durationMs: outcome.durationMs })
  return outcome
}

/**
 * `withRollbackOnlyTransaction`のcallbackとして実行される、トランザクション内5チェック
 * （canary-rollback-verificationを除く）の実行本体。
 * @param {import('postgres').Sql} tx
 * @param {ReturnType<typeof buildFixtureIdentifiers>} identifiers
 * @param {(text: string) => string} redactError
 * @param {((info: { checkId: string, pass: boolean, skipped: boolean, durationMs: number }) => void) | undefined} onCanaryChecked
 */
async function runInTransactionChecks(tx, identifiers, redactError, onCanaryChecked) {
  const checks = []

  checks.push(await runCheck(tx, 'canary-dashboard-reads', redactError, onCanaryChecked, (spTx) => checkDashboardReads(spTx, redactError)))

  let fixtureSetupResult
  try {
    fixtureSetupResult = { ok: true, fixture: await tx.savepoint('canary_fixture_setup', (spTx) => setupFixtures(spTx, identifiers)) }
  } catch (error) {
    fixtureSetupResult = { ok: false, error }
  }

  if (!fixtureSetupResult.ok) {
    // 設計書「fixture INSERT（canary-gacha-rpcの前提データ）の失敗時は、それに依存する
    // 後続チェック（gacha-rpc/updated-at/timestamp/jsonb）をskipped扱いにする」を実装する。
    // fail findingそのものは唯一 canary-gacha-rpc に計上する（fixtureはcanary-gacha-rpcの
    // 前提データという位置付けのため）。他の3チェックはfindingを持たず`skipped:true`のみ
    // （冗長なfindingの重複を避ける。layer全体のpass判定は下記1件のfail findingで
    // 正しくfalseになる）。
    const message = redactError(fixtureSetupResult.error instanceof Error ? fixtureSetupResult.error.message : String(fixtureSetupResult.error))
    const fixtureFinding = canaryFail(
      'CANARY_FIXTURE_SETUP_ERROR',
      `fixture(streamers/cards)行のセットアップに失敗したため、canary-gacha-rpc/canary-updated-at-trigger/canary-timestamp-shape/canary-jsonb-array-parseの4チェックをすべてskipしました: ${message}`
    )
    for (const checkId of FIXTURE_DEPENDENT_CHECK_IDS) {
      const skippedCheck = { id: checkId, pass: false, skipped: true, findings: checkId === 'canary-gacha-rpc' ? [fixtureFinding] : [], durationMs: 0 }
      checks.push(skippedCheck)
      if (onCanaryChecked) onCanaryChecked({ checkId, pass: false, skipped: true, durationMs: 0 })
    }
    return { checks, fixtureContext: { cardId: null } }
  }

  const fixtureContext = fixtureSetupResult.fixture
  const gachaRpcCtx = { streamerId: fixtureContext.streamerId, cardId: fixtureContext.cardId, userTwitchUserId: identifiers.userTwitchUserId, eventId: identifiers.eventId }
  const jsonbCtx = {
    streamerId: fixtureContext.streamerId,
    userTwitchUserId: identifiers.userTwitchUserId,
    gachaSoundRules: fixtureContext.gachaSoundRules,
    customRarities: fixtureContext.customRarities,
    cardPackNames: fixtureContext.cardPackNames,
  }

  checks.push(await runCheck(tx, 'canary-gacha-rpc', redactError, onCanaryChecked, (spTx) => checkGachaRpc(spTx, gachaRpcCtx)))
  checks.push(await runCheck(tx, 'canary-updated-at-trigger', redactError, onCanaryChecked, (spTx) => checkUpdatedAtTrigger(spTx, fixtureContext)))
  checks.push(await runCheck(tx, 'canary-timestamp-shape', redactError, onCanaryChecked, (spTx) => checkTimestampShape(spTx, fixtureContext)))
  checks.push(await runCheck(tx, 'canary-jsonb-array-parse', redactError, onCanaryChecked, (spTx) => checkJsonbArrayParse(spTx, jsonbCtx)))

  return { checks, fixtureContext }
}

/**
 * Layer 6 本体（DB接続あり、target側のみ）。`withRollbackOnlyTransaction`で1つの
 * トランザクションを開き、5チェックを逐次実行してから必ずROLLBACKし、その後
 * トランザクション外でcanary-rollback-verificationを実行する。
 *
 * @param {{
 *   targetSql: import('postgres').Sql,
 *   targetUrl: string,
 *   onCanaryChecked?: (info: { checkId: string, pass: boolean, skipped: boolean, durationMs: number }) => void,
 *   runId?: string,
 * }} args runIdは通常は省略しcrypto.randomUUID()を使う。テスト（fixture衝突シナリオの
 *   決定的な再現）のためだけに上書きを許容する。
 */
export async function runCanaryLayer({ targetSql, targetUrl, onCanaryChecked, runId = crypto.randomUUID() }) {
  const redactError = (text) => core.redactSecretsFromText(text, targetUrl)
  const identifiers = buildFixtureIdentifiers(runId)

  const { checks, fixtureContext } = await withRollbackOnlyTransaction(targetSql, (tx) => runInTransactionChecks(tx, identifiers, redactError, onCanaryChecked))

  const rollbackStartedAt = Date.now()
  let rollbackCheck
  try {
    const rollbackFindings = await verifyRollbackTraceless(targetSql, { ...identifiers, cardId: fixtureContext.cardId })
    rollbackCheck = { id: 'canary-rollback-verification', pass: rollbackFindings.length === 0, skipped: false, findings: rollbackFindings, durationMs: Date.now() - rollbackStartedAt }
  } catch (error) {
    const message = redactError(error instanceof Error ? error.message : String(error))
    rollbackCheck = {
      id: 'canary-rollback-verification',
      pass: false,
      skipped: false,
      findings: [canaryFail('CANARY_RUNTIME_ERROR', `canary-rollback-verification: 実行中にエラーが発生しました: ${message}`)],
      durationMs: Date.now() - rollbackStartedAt,
    }
  }
  if (onCanaryChecked) onCanaryChecked({ checkId: rollbackCheck.id, pass: rollbackCheck.pass, skipped: rollbackCheck.skipped, durationMs: rollbackCheck.durationMs })

  const allChecks = [...checks, rollbackCheck]
  const allFindings = allChecks.flatMap((c) => c.findings)
  // 設計書「layer pass = failが0件」（既存レイヤーと同形式）: skipped/infoの有無に関わらず、
  // severity='fail'のfindingが1件も無ければpass。
  const pass = !allFindings.some((f) => f.severity === 'fail')

  return { layer: 'canary', pass, findings: allFindings, checks: allChecks }
}
