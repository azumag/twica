#!/usr/bin/env node

/**
 * Layer 5（業務invariant）の invariant 定義 / Issue #697 Chunk 3
 *
 * 設計書（Fableレビュー3ラウンド・rev3で承認済み）の判定モデルをそのまま実装する:
 *
 * Tier A（構造的に成立が保証される不変条件）: DB制約・トリガー・RPCのアトミック性により
 * 「違反 = データ破損か移行破損」と断定できるもの。違反件数が1件でもあれば、その側単独で
 * severity='fail'（source/targetの比較を待たない絶対値判定）。
 *
 * Tier B（正規のアプリ操作で崩れうる状態）: 履歴行の任意削除・上限の事後引き下げ・
 * storage RPC失敗の黙殺・CASCADE削除・users削除など、正規機能の組み合わせだけで
 * いつでも新規発生しうる状態。絶対値でfailにすると「リハーサル時にpassしても当日までの間に
 * 正規操作で新規発生し偽NO-GOになる」ため、source/targetの(違反件数, 違反識別子digest)が
 * 一致するかどうかで判定する（両方とも移行前から同じ違反を抱えている＝移行は忠実、という解釈）。
 *
 * 本ファイルはSQL文字列を組み立てる**純粋関数**のみを持つ（DB接続なし、単体テスト対象）。
 * 実行本体（DB接続・トランザクション・try/catch）は layer-invariants.mjs が担う。
 *
 * ---
 * 「identifier列に統一する」設計（本ファイル最大の設計判断）:
 * 各checkの `violatorsCte`（WITH句の本体になるSQL片）は、必ず `identifier` という名前の
 * 単一のtext列を1違反1行で返す規約にする。呼び出し側（buildViolationCountSql等）は
 * この規約に従う限り、どんなJOIN構造・どんな複合キーの invariant でも同じ3つの
 * ジェネリック関数（count/sample/digest）で処理できる。複合キー（例:
 * channel-point-usage-recalcのstreamer_id+user_twitch_id）は `violatorsCte` の
 * SELECT内で `COALESCE(a,b)::text || ':' || COALESCE(c,d)` のように事前に1列へ
 * 連結してしまうことで、この規約を維持している。
 *
 * この統一により、以下が全invariant共通で保証される（設計書の要求事項）:
 *   - サンプル・digestのソートは常に `identifier COLLATE "C"` で決定的（bytewise順、
 *     source/targetのサーバーlocale設定差に依存しない。layer-data.mjsのCOLLATE "C"強制と
 *     同じ理由）。
 *   - サンプルは violatorsCte が返す `identifier` 列そのもの（各invariantの実装が
 *     PK uuid・event_id・user_prefix・Twitch数値IDのみを `identifier` として
 *     SELECTしていることは本ファイルのSQLで担保する。usernameや表示名等の自由テキスト、
 *     secret列の値は絶対に `identifier` として選ばない）。
 *   - 値比較・タイムスタンプ比較・numeric比較は `violatorsCte` 内で完結させ、
 *     `IS DISTINCT FROM`（NULL-safe）を使う。postgres.jsのJS Date変換や文字列変換を
 *     一切経由しない（設計書「SQLの値比較...は全てSQL側で完結」の要求）。
 *
 * ---
 * COUNT(*)を`::int`にキャストする理由（`::bigint`にしない理由）:
 * PostgreSQLの`COUNT(*)`は素の状態でbigint（int8, OID 20）を返す。postgres.jsは
 * デフォルト設定でint8をJSの数値精度ロスを避けるため文字列として返す
 * （canonicalize.mjs冒頭コメント「numeric/bigintの文字列表現は...」と同じ挙動）。
 * 本layerが数えるのは「1回の検証実行で見つかる違反件数」であり、本アプリの実データ規模
 * （ユーザー数・カード数のオーダー）を踏まえれば2^31を超えることは現実的にありえないため、
 * `::int`（int4, OID 23）にキャストしてpostgres.jsのデフォルト型パーサに数値として
 * 直接パースさせ、呼び出し側（layer-invariants.mjs）でのbigint文字列→数値変換処理を
 * 不要にしている（YAGNI: 不要な変換ロジックを増やさない）。
 *
 * ---
 * string_aggの区切り文字について:
 * `md5(string_agg(identifier, <区切り文字> ORDER BY identifier COLLATE "C"))` で
 * digestを計算する（設計書の指定どおり）。区切り文字は `,`（カンマ）を使う。
 * 本layerが `identifier` として選ぶ値は UUID・Twitch数値ID・8文字ハッシュの
 * user_prefix・N連event_id（`{messageId}` または `{messageId}:{n}`、messageIdは
 * UUID形）のいずれかのみであり、いずれの形式もカンマを含み得ない（cards-safe-columns等の
 * 自由入力テキストは`identifier`として選ばない設計、本ファイル冒頭コメント参照）。
 * よってカンマ区切りでの曖昧さ（値自体にカンマが含まれ、結合結果が別の値集合と衝突する）は
 * 起こらない。
 */

'use strict'

/** Tier A: 構造的に成立が保証される不変条件（絶対値fail）。 */
export const TIER_A = 'A'
/** Tier B: 正規のアプリ操作で崩れうる状態（source/target両側一致型）。 */
export const TIER_B = 'B'

/**
 * @typedef {{ code: string, tier: 'A'|'B', countSql: string, sampleSql: string, digestSql: string | null }} InvariantCheckDef
 * @typedef {{ id: string, description: string, requiredTables: string[], checks: InvariantCheckDef[] }} InvariantDef
 *
 * これらのtypedefをlayer-invariants.mjs（実行本体）が`import('./invariant-checks.mjs').InvariantDef`
 * の形で参照する。`typeof INVARIANTS`をそのまま参照する方式にすると、TypeScript側の型が
 * INVARIANTS定数の実際の内容から逐語的に推論された巨大なリテラル型になり、
 * テストコードでfixtureのinvariant定義を書くたびに型が合わずビルドが壊れる
 * （tierフィールドが`'A'|'B'`ではなく推論結果次第で`string`に広がる等）。
 * 名前付きのtypedefを介すことで、構造的に同じ形であれば型チェックが通るようにする。
 */

/**
 * 1件の違反チェックの内部表現。`violatorsCte`（純粋なSQL文字列）から
 * count/sample/digest の3種類のSQLを組み立てる。
 * @param {string} code report上のfinding/check識別コード（UPPER_SNAKE_CASE）
 * @param {'A'|'B'} tier
 * @param {string} violatorsCte `identifier`という単一text列を1違反1行で返すSELECT文
 *   （WITH句の本体として埋め込まれる。末尾セミコロン無し）
 * @returns {{ code: string, tier: 'A'|'B', countSql: string, sampleSql: string, digestSql: string | null }}
 */
function buildCheck(code, tier, violatorsCte) {
  return {
    code,
    tier,
    countSql: buildViolationCountSql(violatorsCte),
    sampleSql: buildViolationSampleSql(violatorsCte),
    // Tier Aはsource/targetを独立に絶対値判定するためdigestを使わない（クロスサイド比較が
    // 不要）。digestSqlを常に生成すると使われないクエリを毎回1本余分に実行することになり、
    // freeze中の実行時間を無駄に伸ばすため、Tier Aではnullのままにして
    // layer-invariants.mjs側で「digestSqlがnullなら実行しない」という制御に使う。
    digestSql: tier === TIER_B ? buildViolationDigestSql(violatorsCte) : null,
  }
}

/**
 * 違反件数を数えるSQLを組み立てる純粋関数。
 * @param {string} violatorsCte
 * @returns {string}
 */
export function buildViolationCountSql(violatorsCte) {
  return `WITH violators AS (\n${violatorsCte}\n)\nSELECT COUNT(*)::int AS count FROM violators`
}

/**
 * 違反サンプル（最大10件、`identifier COLLATE "C"`昇順）を取得するSQLを組み立てる純粋関数。
 * @param {string} violatorsCte
 * @returns {string}
 */
export function buildViolationSampleSql(violatorsCte) {
  return `WITH violators AS (\n${violatorsCte}\n)\nSELECT identifier FROM violators ORDER BY identifier COLLATE "C" LIMIT 10`
}

/**
 * 違反識別子集合のdigest（`md5(string_agg(identifier, ',' ORDER BY identifier COLLATE "C"))`）を
 * 計算するSQLを組み立てる純粋関数。Tier Bのsource/targetクロスサイド比較にのみ使う。
 * @param {string} violatorsCte
 * @returns {string}
 */
export function buildViolationDigestSql(violatorsCte) {
  return `WITH violators AS (\n${violatorsCte}\n)\nSELECT md5(string_agg(identifier, ',' ORDER BY identifier COLLATE "C")) AS digest FROM violators`
}

/**
 * invariant定義一覧（issue #697本文の9項目 + 設計書レビューで追加された
 * card-stone-balance-recalc、計12 invariant id）。
 *
 * 各要素:
 *   - id: 設計書「invariant一覧」表のid（report・allowlistの`invariantId`として使う）
 *   - description: reportに出す説明文
 *   - requiredTables: 実行前に`to_regclass`で存在確認する対象テーブル（layer-invariants.mjsが使う）
 *   - checks: 1つ以上の { code, tier, countSql, sampleSql, digestSql }
 *
 * 1つのinvariant idが複数checkを持つケースについて（設計書の記述との対応関係）:
 * 設計書の表はTier A/Bが混在する行（例: gacha-history-required-keys＝「Tier A + B」）を
 * 1行で表現しているが、実行時の判定はTierごとに別ルールになるため、実装上は
 * 「1 invariant id = 1つ以上のcheck、checkごとに独立したtier/pass判定」という構造にした。
 * 判定モデル（Tier A/B、fail/info、digest比較）自体は設計書から一切変更していない
 * （invariant一覧表の粒度をそのままJSONのcheck配列の要素数として展開しただけ）。
 */
export const INVARIANTS = [
  // ---------------------------------------------------------------------
  // #1: orphan-foreign-keys（Tier A）
  // FK制約（00001、全てON DELETE CASCADE）が生きていれば構造的に常に0件になるはずの
  // orphan行を数える「保険」。移行時のrestore破損（FK制約の適用漏れ、部分restoreでの
  // 順序不整合等）を検知する。5経路それぞれを独立したcheckにする（設計書「FK 5経路の
  // orphan COUNT」）。
  // ---------------------------------------------------------------------
  {
    id: 'orphan-foreign-keys',
    description: 'FK制約が保証するはずの参照整合性（user_cards/cards/gacha_history → users/cards/streamers）の保険的チェック。制約が正しく適用されていれば恒常的に0件。',
    requiredTables: ['user_cards', 'users', 'cards', 'gacha_history', 'streamers'],
    checks: [
      buildCheck(
        'ORPHAN_USER_CARDS_USER_ID',
        TIER_A,
        `SELECT uc.id::text AS identifier
FROM user_cards uc
LEFT JOIN users u ON u.id = uc.user_id
WHERE u.id IS NULL`
      ),
      buildCheck(
        'ORPHAN_USER_CARDS_CARD_ID',
        TIER_A,
        `SELECT uc.id::text AS identifier
FROM user_cards uc
LEFT JOIN cards c ON c.id = uc.card_id
WHERE c.id IS NULL`
      ),
      buildCheck(
        'ORPHAN_CARDS_STREAMER_ID',
        TIER_A,
        `SELECT c.id::text AS identifier
FROM cards c
LEFT JOIN streamers s ON s.id = c.streamer_id
WHERE s.id IS NULL`
      ),
      buildCheck(
        'ORPHAN_GACHA_HISTORY_CARD_ID',
        TIER_A,
        `SELECT gh.id::text AS identifier
FROM gacha_history gh
LEFT JOIN cards c ON c.id = gh.card_id
WHERE c.id IS NULL`
      ),
      buildCheck(
        'ORPHAN_GACHA_HISTORY_STREAMER_ID',
        TIER_A,
        `SELECT gh.id::text AS identifier
FROM gacha_history gh
LEFT JOIN streamers s ON s.id = gh.streamer_id
WHERE s.id IS NULL`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #2a: gacha-history-required-keys（Tier A: 必須列のNULL保険、Tier B: legacy event_id NULL）
  // user_twitch_id/card_id/streamer_idはschema.ts上NOT NULLだが、DB制約が万一適用されて
  // いない状態（移行漏れ）を検知する保険としてTier A扱い。event_idは仕様上NULL許容
  // （旧手動ドロー由来）で正規に発生しうるためTier B（source/target一致型）。
  // ---------------------------------------------------------------------
  {
    id: 'gacha-history-required-keys',
    description: 'gacha_historyの必須列（user_twitch_id/card_id/streamer_id）NULL件数の保険チェック（Tier A）と、legacy行由来のevent_id NULL件数（Tier B、両側一致型）。',
    requiredTables: ['gacha_history'],
    checks: [
      buildCheck(
        'GACHA_HISTORY_REQUIRED_COLUMN_NULL',
        TIER_A,
        `SELECT id::text AS identifier
FROM gacha_history
WHERE user_twitch_id IS NULL OR card_id IS NULL OR streamer_id IS NULL`
      ),
      buildCheck(
        'GACHA_HISTORY_EVENT_ID_NULL',
        TIER_B,
        `SELECT id::text AS identifier
FROM gacha_history
WHERE event_id IS NULL`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #2b: gacha-event-id-duplicates（Tier A）
  // gacha_history.event_id の UNIQUE制約（00076でNULL拒否も追加済み）が生きていれば
  // 非NULL event_id の重複は構造的に発生しない「保険」。
  // ---------------------------------------------------------------------
  {
    id: 'gacha-event-id-duplicates',
    description: 'gacha_history.event_id（非NULL）のUNIQUE制約が保証するはずの重複排除の保険的チェック。',
    requiredTables: ['gacha_history'],
    checks: [
      buildCheck(
        'GACHA_EVENT_ID_DUPLICATE',
        TIER_A,
        `SELECT event_id AS identifier
FROM gacha_history
WHERE event_id IS NOT NULL
GROUP BY event_id
HAVING COUNT(*) > 1`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #3: nren-event-id-prefix（Tier B）
  // N連event_id形式（1枚目={messageId}、2枚目以降={messageId}:{n}、n=2..N）の構造整合性。
  // `DELETE /api/gacha-history/[id]` はユーザー向け正規機能で、N連バッチの任意の1行を
  // いつでも単独削除できるため、base不在・歯抜けは正規操作の結果として発生しうる
  // （設計書rev1のfailからTier Bへ変更された根拠）。
  //
  // 正規表現 `^.+:[0-9]+$` について: N連のmessageId（base）自体が`:数字`で終端する形は
  // 現行の採番方式（UUID形のEventSub message id）では発生しない前提（設計書に明記）。
  // よってこの正規表現は「サフィックス付き行」を誤りなく特定できる。
  // ---------------------------------------------------------------------
  {
    id: 'nren-event-id-prefix',
    description: 'N連ガチャのevent_id構造（{messageId}:{n}のbase行存在・サフィックス連番の歯抜け無し）。単一行削除は正規機能のため両側一致型（Tier B）。',
    requiredTables: ['gacha_history'],
    checks: [
      buildCheck(
        'NREN_EVENT_ID_PREFIX_BASE_MISSING',
        TIER_B,
        `WITH suffix_rows AS (
  SELECT event_id, substring(event_id from '^(.+):[0-9]+$') AS base
  FROM gacha_history
  WHERE event_id ~ '^.+:[0-9]+$'
)
SELECT sr.event_id AS identifier
FROM suffix_rows sr
LEFT JOIN gacha_history base_row ON base_row.event_id = sr.base
WHERE base_row.id IS NULL`
      ),
      buildCheck(
        'NREN_EVENT_ID_PREFIX_GAP',
        TIER_B,
        `WITH suffix_rows AS (
  SELECT
    substring(event_id from '^(.+):[0-9]+$') AS base,
    substring(event_id from ':([0-9]+)$')::int AS suffix_n
  FROM gacha_history
  WHERE event_id ~ '^.+:[0-9]+$'
),
per_base AS (
  SELECT base, array_agg(DISTINCT suffix_n ORDER BY suffix_n) AS suffixes, MAX(suffix_n) AS max_n
  FROM suffix_rows
  GROUP BY base
)
SELECT base AS identifier
FROM per_base
WHERE suffixes IS DISTINCT FROM ARRAY(SELECT generate_series(2, max_n))`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #4a: card-issuance-over-limit（Tier B）
  // `PUT /api/cards/[id]` は発行済み枚数と比較せず max_issuance_count を設定できる
  // （形式検証のみ）ため、上限の事後引き下げによる「超過発行状態」は正規操作で
  // 到達可能（設計書rev1のfailからTier Bへ変更された根拠）。
  // ---------------------------------------------------------------------
  {
    id: 'card-issuance-over-limit',
    description: 'card単位のCOUNT(user_cards) > max_issuance_count。上限の事後引き下げが正規操作のため両側一致型（Tier B）。',
    requiredTables: ['cards', 'user_cards'],
    checks: [
      buildCheck(
        'CARD_ISSUANCE_OVER_LIMIT',
        TIER_B,
        `SELECT c.id::text AS identifier
FROM cards c
WHERE c.max_issuance_count IS NOT NULL
  AND (SELECT COUNT(*) FROM user_cards uc WHERE uc.card_id = c.id) > c.max_issuance_count`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #5: channel-point-usage-recalc（Tier B）
  // channel_point_usage_stats（00039）はgacha_historyのトリガーで維持される「絶対値上書き型」
  // 集計（refresh_channel_point_usage_stat がSELECTで全量再計算→upsert）。READ COMMITTEDの
  // スナップショット特性上、同一(streamer_id, user_twitch_id)への並行引き換えでlost updateが
  // 構造的に起こりうるためTier B（設計書rev2レビューMajor-1(a)）。
  // 値比較（total_points/redemption_count/last_redeemed_at）は全てSQL側 IS DISTINCT FROM。
  // ---------------------------------------------------------------------
  {
    id: 'channel-point-usage-recalc',
    description: 'gacha_history(reward_cost>0)からの再計算 vs channel_point_usage_stats。refreshが絶対値上書き型でlost update raceがあるため両側一致型（Tier B）。',
    requiredTables: ['gacha_history', 'channel_point_usage_stats'],
    checks: [
      buildCheck(
        'CHANNEL_POINT_USAGE_RECALC_MISMATCH',
        TIER_B,
        `WITH recalced AS (
  SELECT streamer_id, user_twitch_id,
    SUM(reward_cost)::bigint AS total_points,
    COUNT(*)::int AS redemption_count,
    MAX(redeemed_at) AS last_redeemed_at
  FROM gacha_history
  WHERE reward_cost IS NOT NULL AND reward_cost > 0
  GROUP BY streamer_id, user_twitch_id
)
SELECT COALESCE(r.streamer_id, s.streamer_id)::text || ':' || COALESCE(r.user_twitch_id, s.user_twitch_id) AS identifier
FROM recalced r
FULL OUTER JOIN channel_point_usage_stats s
  ON s.streamer_id = r.streamer_id AND s.user_twitch_id = r.user_twitch_id
WHERE r.total_points IS DISTINCT FROM s.total_points
   OR r.redemption_count IS DISTINCT FROM s.redemption_count
   OR r.last_redeemed_at IS DISTINCT FROM s.last_redeemed_at`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #6: support-code-license-state（Tier A、将来allowlist前提）
  // revoke_support_code RPCはstatus更新とuser_licenses削除を同一トランザクションで行うが、
  // 管理UIの汎用PATCH（analysis/dev/localAdminApi.ts）はstatusを直接UPDATEでき、
  // ライセンス削除を伴わない。頻度が低く管理者操作起因のためTier A
  // （fail-until-allowlist。実行時はplan.tsのstatus JOINフィルタで無害化されている旨は
  // reportのdescriptionで補足する）。
  // ---------------------------------------------------------------------
  {
    id: 'support-code-license-state',
    description: 'revokedなsupport_codesに紐づくuser_licenses残存。revoke_support_code RPCは削除も行うが、管理UIの汎用PATCHはstatusのみ直接更新できるため発生しうる（実行時はplan.tsのstatus JOINで無害化されている）。',
    requiredTables: ['support_codes', 'user_licenses'],
    checks: [
      buildCheck(
        'SUPPORT_CODE_REVOKED_LICENSE_RESIDUAL',
        TIER_A,
        `SELECT ul.id::text AS identifier
FROM user_licenses ul
JOIN support_codes sc ON sc.id = ul.code_id
WHERE sc.status = 'revoked'`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #7: storage-usage-integrity（Tier A: 負値保険、Tier B: 値突合）
  // update_storage_usage関数（00006）は GREATEST(0, ...) で負値化を防ぐため、負値は
  // 構造的に恒常0（Tier A保険）。一方、全ファイル削除ユーザーの0/0残存やRPC失敗の
  // 黙殺（ログのみ、補正ジョブ無し）によるdriftは正規運用で発生しうるためTier B。
  // 不在側はCOALESCE 0で比較し、0/0行の残存自体は違反にしない。
  // ---------------------------------------------------------------------
  {
    id: 'storage-usage-integrity',
    description: 'storage_usageの負値保険（Tier A）と、blob_filesからの再計算とのuser_prefix単位の値突合・_global_行 vs 全体合計（Tier B、両側一致型）。',
    requiredTables: ['storage_usage', 'blob_files'],
    checks: [
      buildCheck(
        'STORAGE_USAGE_NEGATIVE_VALUE',
        TIER_A,
        `SELECT user_prefix AS identifier
FROM storage_usage
WHERE bytes_used < 0 OR blob_count < 0`
      ),
      buildCheck(
        'STORAGE_USAGE_PER_USER_MISMATCH',
        TIER_B,
        `WITH recalced AS (
  SELECT user_prefix, SUM(file_size)::bigint AS bytes_used, COUNT(*)::int AS blob_count
  FROM blob_files
  GROUP BY user_prefix
),
per_user_storage AS (
  SELECT user_prefix, bytes_used, blob_count
  FROM storage_usage
  WHERE user_prefix <> '_global_'
)
SELECT COALESCE(r.user_prefix, s.user_prefix) AS identifier
FROM recalced r
FULL OUTER JOIN per_user_storage s ON s.user_prefix = r.user_prefix
WHERE COALESCE(r.bytes_used, 0) IS DISTINCT FROM COALESCE(s.bytes_used, 0)
   OR COALESCE(r.blob_count, 0) IS DISTINCT FROM COALESCE(s.blob_count, 0)`
      ),
      buildCheck(
        'STORAGE_USAGE_GLOBAL_MISMATCH',
        TIER_B,
        `WITH totals AS (
  SELECT COALESCE(SUM(file_size), 0)::bigint AS bytes_used, COUNT(*)::int AS blob_count
  FROM blob_files
),
global_row AS (
  SELECT bytes_used, blob_count FROM storage_usage WHERE user_prefix = '_global_'
)
SELECT '_global_' AS identifier
FROM totals t
LEFT JOIN global_row g ON true
WHERE t.bytes_used IS DISTINCT FROM COALESCE(g.bytes_used, 0)
   OR t.blob_count IS DISTINCT FROM COALESCE(g.blob_count, 0)`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #8: streamer-card-active-combination（Tier A）
  // streamers.is_active を false にする経路がアプリに存在しないため、
  // 「is_active=trueのカードがis_active=falseの配信者に属する」状態は構造的に恒常0。
  // ---------------------------------------------------------------------
  {
    id: 'streamer-card-active-combination',
    description: 'is_active=trueのcardsがis_active=falseのstreamersに属する組み合わせ。streamers.is_activeをfalseにする経路がアプリに無いため恒常0の保険的チェック。',
    requiredTables: ['cards', 'streamers'],
    checks: [
      buildCheck(
        'STREAMER_CARD_ACTIVE_COMBINATION_VIOLATION',
        TIER_A,
        `SELECT c.id::text AS identifier
FROM cards c
JOIN streamers s ON s.id = c.streamer_id
WHERE c.is_active = TRUE AND s.is_active = FALSE`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #9a: card-owner-stats-recalc（Tier B）
  // user_cards JOIN cards JOIN users からの再計算 vs card_owner_stats。孤児行
  // （users削除でtwitch_user_id解決不能）は突合から除外し、専用codeで別計上する
  // （ユーザー再登録エッジ含め、正規操作の連鎖のみで発生しうるためTier B）。
  // rev1の「SUM(owned_count) vs 実所持数」はこのinvariantに統合済み（設計書Major-4）。
  // ---------------------------------------------------------------------
  {
    id: 'card-owner-stats-recalc',
    description: 'user_cards起点の再計算 vs card_owner_stats。孤児行（users削除由来）は別code（両側一致型）、値突合も絶対値上書き型refreshのlost update raceのため両側一致型（Tier B）。',
    requiredTables: ['user_cards', 'cards', 'users', 'card_owner_stats'],
    checks: [
      buildCheck(
        'CARD_OWNER_STATS_ORPHAN_USER',
        TIER_B,
        `SELECT cos.streamer_id::text || ':' || cos.card_id::text || ':' || cos.user_twitch_id AS identifier
FROM card_owner_stats cos
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.twitch_user_id = cos.user_twitch_id)`
      ),
      buildCheck(
        'CARD_OWNER_STATS_VALUE_MISMATCH',
        TIER_B,
        `WITH recalced AS (
  SELECT c.streamer_id, uc.card_id, u.twitch_user_id AS user_twitch_id,
    COUNT(*)::int AS owned_count, MAX(uc.obtained_at) AS last_obtained_at
  FROM user_cards uc
  JOIN cards c ON c.id = uc.card_id
  JOIN users u ON u.id = uc.user_id
  GROUP BY c.streamer_id, uc.card_id, u.twitch_user_id
),
resolvable_stats AS (
  -- 孤児行（対応するusersが存在しない）はCARD_OWNER_STATS_ORPHAN_USERで別計上するため、
  -- ここでの値突合対象からは除外する（同じ行が2つのcodeで二重にfailするのを防ぐ、
  -- 設計書rev1レビューMajor-4「分類不整合の解消」）。
  SELECT cos.*
  FROM card_owner_stats cos
  WHERE EXISTS (SELECT 1 FROM users u WHERE u.twitch_user_id = cos.user_twitch_id)
)
SELECT COALESCE(r.streamer_id, s.streamer_id)::text || ':' || COALESCE(r.card_id, s.card_id)::text || ':' || COALESCE(r.user_twitch_id, s.user_twitch_id) AS identifier
FROM recalced r
FULL OUTER JOIN resolvable_stats s
  ON s.streamer_id = r.streamer_id AND s.card_id = r.card_id AND s.user_twitch_id = r.user_twitch_id
WHERE r.owned_count IS DISTINCT FROM s.owned_count
   OR r.last_obtained_at IS DISTINCT FROM s.last_obtained_at`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #9b: battle-stats-consistency（Tier A、テーブル存在時のみ実行）
  // 再計算完全一致は放棄（battle_statsは累積統計であり、CASCADE削除で減った生存battles行
  // からの再計算とは一致しない構造のため）。代わりに構造的に保証される2条件を検証する:
  //   (a) 行内整合: wins+losses+draws=total_battles かつ win_rateが正しい計算値
  //       （NULL-safe比較 + 0除算ガード + total_battles=0なのに counters<>0 の別条件 +
  //       total_battles自体がNULLの行を明示条件で捕捉。オーケストレーターレビュー
  //       Minor-1対応: `total_battles IS NULL` かつ counters の少なくとも1つもNULL
  //       （例: total=NULL, wins=NULL, losses=0, draws=0）の行は、`(wins+losses+draws)
  //       IS DISTINCT FROM total_battles` が `NULL IS DISTINCT FROM NULL = false` に
  //       なり、かつ他の2条件も `bs.total_battles > 0`/`= 0` がNULLとの比較でNULL
  //       （非TRUE）になるため3条件すべてをすり抜けていた（PG17実測で再現確認済みの
  //       偽陰性）。`bs.total_battles IS NULL` を独立したOR条件として追加し、
  //       total_battles自体の欠落を無条件でfailにする。正規のトリガー経由データでは
  //       total_battlesがNULLになる経路が無いため、この追加条件による誤検知は無い）。
  //   (b) 片側不等式: battles起点で再計算した各counterに対し、battle_statsの対応counterが
  //       常に以上であること（stats行不在は0扱いで検出、偽陰性を避けるためbattles起点で
  //       JOINする）。
  // トリガーは差分演算型（`x = x + delta`）でlost updateしないためTier A適格。
  // requiredTables（battles/battle_stats）は本番では#625により両側不在が正常系のため、
  // cutover-allowlist.mjsのBATTLE_FEATURE_TABLES_ABSENT_IN_PRODエントリでinfo+skipされる
  // （layer-invariants.mjs参照）。
  // ---------------------------------------------------------------------
  {
    id: 'battle-stats-consistency',
    description: 'battle_statsの行内整合（wins+losses+draws=total_battles、win_rate計算式）と、battles起点で再計算したcounterに対する片側不等式。トリガーが差分演算型でlost updateしないためTier A。',
    requiredTables: ['battles', 'battle_stats'],
    checks: [
      buildCheck(
        'BATTLE_STATS_ROW_INCONSISTENT',
        TIER_A,
        `SELECT bs.id::text AS identifier
FROM battle_stats bs
WHERE bs.total_battles IS NULL
   OR (bs.wins + bs.losses + bs.draws) IS DISTINCT FROM bs.total_battles
   OR (
     bs.total_battles > 0
     AND bs.win_rate IS DISTINCT FROM ROUND((bs.wins * 100.0) / bs.total_battles, 2)
   )
   OR (
     bs.total_battles = 0
     AND (COALESCE(bs.wins, 0) <> 0 OR COALESCE(bs.losses, 0) <> 0 OR COALESCE(bs.draws, 0) <> 0)
   )`
      ),
      buildCheck(
        'BATTLE_STATS_COUNTER_UNDERCOUNT',
        TIER_A,
        `WITH recalced AS (
  SELECT
    b.user_id,
    COUNT(*) FILTER (WHERE b.result = 'win') AS wins,
    COUNT(*) FILTER (WHERE b.result = 'lose') AS losses,
    COUNT(*) FILTER (WHERE b.result = 'draw') AS draws,
    COUNT(*) AS total_battles
  FROM battles b
  GROUP BY b.user_id
)
SELECT r.user_id::text AS identifier
FROM recalced r
LEFT JOIN battle_stats bs ON bs.user_id = r.user_id
WHERE COALESCE(bs.wins, 0) < r.wins
   OR COALESCE(bs.losses, 0) < r.losses
   OR COALESCE(bs.draws, 0) < r.draws
   OR COALESCE(bs.total_battles, 0) < r.total_battles`
      ),
    ],
  },

  // ---------------------------------------------------------------------
  // #10: card-stone-balance-recalc（Tier A）
  // exchange_duplicate_card_for_stones RPC（00059）は同一トランザクション内で
  // 差分演算型更新（`balance + EXCLUDED.balance`）を行い、消費経路が存在しない（#519保留）
  // ため、SUM(card_stone_transactions.amount) と balances.balance は構造的に常に完全一致する
  // （設計書で確認済みのTier A適格ケース）。
  // ---------------------------------------------------------------------
  {
    id: 'card-stone-balance-recalc',
    description: '(user_id, streamer_id)単位のSUM(card_stone_transactions.amount) vs card_stone_balances.balance。RPC内同一トランザクション・差分演算型更新・消費経路無しのため完全一致が構造的に保証される。',
    requiredTables: ['card_stone_transactions', 'card_stone_balances'],
    checks: [
      buildCheck(
        'CARD_STONE_BALANCE_RECALC_MISMATCH',
        TIER_A,
        `WITH recalced AS (
  SELECT user_id, streamer_id, SUM(amount)::int AS balance
  FROM card_stone_transactions
  GROUP BY user_id, streamer_id
)
SELECT COALESCE(r.user_id, b.user_id)::text || ':' || COALESCE(r.streamer_id, b.streamer_id)::text AS identifier
FROM recalced r
FULL OUTER JOIN card_stone_balances b
  ON b.user_id = r.user_id AND b.streamer_id = r.streamer_id
WHERE COALESCE(r.balance, 0) IS DISTINCT FROM COALESCE(b.balance, 0)`
      ),
    ],
  },
]
