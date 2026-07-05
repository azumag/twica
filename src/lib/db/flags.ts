/**
 * DB ドライバ切替フラグ (#570, #568 Phase 1)
 *
 * Supabase → PlanetScale 段階移行の Phase 1 として、データアクセス層を
 * PostgREST (supabase-js) から postgres.js + Drizzle 直結へ「段階的に」切り替える。
 * DB 本体は Supabase のまま・スキーマ変更なしで、経路だけを環境変数で切り替える。
 *
 * 運用意図（切替は必ずこの順で行い、問題があれば env を戻すだけでロールバック）:
 *   1. DB_DRIVER 未設定 = 'postgrest' … 完全に従来どおり（マージ・デプロイしても挙動不変）
 *   2. DB_DRIVER=pg-read            … 読み取りのみ pg 直結（書き込みは PostgREST のまま）
 *   3. DB_DRIVER=pg                 … 読み書きとも pg 直結
 * まず preview 環境で pg-read → pg を検証した後、prod で同順に切り替える。
 * 詳細な手順は docs/db-driver-migration.md を参照。
 */

export type DbDriverMode = 'postgrest' | 'pg-read' | 'pg'

/**
 * 現在の DB ドライバモードを返す。
 *
 * 重要: process.env.DB_DRIVER は「呼び出しのたびに」読む。モジュールトップの
 * const にキャッシュしてはならない。OpenNext (Cloudflare Workers) は環境変数を
 * populateProcessEnv でランタイムに注入するため、モジュール評価時点では env が
 * まだ確定していないことがある（評価時に読むと常に undefined = 'postgrest' に
 * 固定されてしまい、フラグが効かなくなる）。
 *
 * 未設定・不正値は安全側の 'postgrest'（完全従来動作）に倒す。
 *
 * trim する理由: Cloudflare ダッシュボード / wrangler secret put 経由の設定は
 * 改行・空白が混入しうる（supabase/admin.ts の getSupabaseCredentials と同じ
 * 既知リスク）。trim しないと 'pg\n' が不正値扱いになり意図した切替が黙って
 * 効かない。
 */
export function getDbDriverMode(): DbDriverMode {
  const raw = process.env.DB_DRIVER?.trim()
  if (raw === 'pg' || raw === 'pg-read') {
    return raw
  }
  return 'postgrest'
}

/**
 * pg 直結の「読み取り」経路が有効か。
 * 'pg-read'（読み取りのみ）と 'pg'（読み書き）の両方で true。
 */
export function isPgReadEnabled(): boolean {
  const mode = getDbDriverMode()
  return mode === 'pg-read' || mode === 'pg'
}

/**
 * pg 直結の「書き込み」経路が有効か。
 * 'pg'（読み書き）のみ true。'pg-read' では書き込みは PostgREST 経路のまま。
 */
export function isPgWriteEnabled(): boolean {
  return getDbDriverMode() === 'pg'
}

/**
 * ガチャ経路（EventSub 由来の書き込みを含むクリティカルパス）専用のドライバ選択 (#573)。
 *
 * GACHA_DB_DRIVER はガチャ経路「だけ」を個別にロールバック/先行切替するための
 * 緊急スイッチ。全体フラグ（DB_DRIVER）を触らずに、収益・ユーザー体験へ直結する
 * ガチャ書き込みのみを即座に旧経路へ戻せるようにしておく（本番障害時の影響範囲を
 * 最小化するための独立レバー）。
 *
 * 優先順位:
 *   1. GACHA_DB_DRIVER が 'pg' / 'postgrest' ならそれを最優先
 *   2. 未設定・不正値なら全体フラグに従う（isPgWriteEnabled() ? 'pg' : 'postgrest'）
 *
 * trim する理由: この値は「インシデント対応中に急いで設定される」性質のもの。
 * 'postgrest\n'（末尾改行混入）が不正値扱いになると、DB_DRIVER=pg が生きている
 * 限りフォールバックで 'pg' のまま動き続け、緊急ロールバックが黙って効かない。
 */
export function getGachaDbDriver(): 'postgrest' | 'pg' {
  const raw = process.env.GACHA_DB_DRIVER?.trim()
  if (raw === 'pg' || raw === 'postgrest') {
    return raw
  }
  return isPgWriteEnabled() ? 'pg' : 'postgrest'
}
