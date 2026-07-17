/**
 * Maintenance write allowlist のパスマッチ純関数 (#694 Stage 3)
 *
 * config/maintenance-write-surfaces.json (write surface の棚卸し) に対して、
 * 「このリクエスト (pathname + method) は maintenance mode 中でもブロックせず
 * 通す対象か」を判定する。判定対象は maintenanceBehavior が 'allow' または
 * 'queue-during-maintenance' のエントリのみ（'block' は allowlist に無い＝
 * デフォルトでブロックされるため、ここでの判定に登場する必要がない。'redirect' は
 * GET route が個別に guardWriteRedirect を呼ぶ経路であり、POST/PUT/PATCH/DELETE
 * のみを見る middleware の一律ブロックとは別経路）。
 *
 * 純粋関数として実装する理由: src/middleware.ts は config/*.json を静的 import
 * するだけで、実際のマッチング判定ロジックはここに切り出す。これにより
 * config/maintenance-write-surfaces.json の実データに依存しない fixture で
 * 単体テストできる（tests/unit/maintenance-allowlist.test.ts）。
 */

/** config/maintenance-write-surfaces.json の各エントリが取りうる分類。 */
export type MaintenanceWriteBehavior =
  | 'block'
  | 'allow'
  | 'redirect'
  | 'queue-during-maintenance'

/**
 * matchesSurfacePath / isMaintenanceWriteExempt が実際に参照するフィールドのみを
 * 持つ最小の型。config/maintenance-write-surfaces.json の各エントリは category /
 * reason / owner / reviewedAt 等の追加フィールドを持つが、パスマッチには使わない
 * ため、構造的部分型として JSON の import 結果をそのまま渡せる。
 */
export interface MaintenanceWriteSurface {
  path: string
  methods: string[]
  maintenanceBehavior: MaintenanceWriteBehavior
}

/**
 * maintenanceBehavior のうち、middleware の一律ブロックを回避してよいもの。
 * 'block' はデフォルト動作（allowlist 不一致）そのものなのでここには含めない。
 * 'redirect' は GET 専用の別経路（guardWriteRedirect を route 側で個別に呼ぶ）
 * であり、POST/PUT/PATCH/DELETE を弾く本判定の対象外。
 */
const EXEMPT_BEHAVIORS: readonly MaintenanceWriteBehavior[] = [
  'allow',
  'queue-during-maintenance',
]

/**
 * pathname が pattern にマッチするかを判定する。
 *
 * pattern が "/" で終わる場合はプレフィックス一致（動的セグメント
 * [id] 等を持つルートを "/api/cards/" のような形で登録するケース向け）、
 * それ以外は完全一致とする。
 *
 * 完全一致をデフォルトにする理由: 単純な startsWith だけだと
 * "/api/twitch/eventsub" のような prefix が "/api/twitch/eventsub/subscribe"
 * のような別ルート（異なる maintenanceBehavior を持つ）まで誤って
 * マッチしてしまう。トレーリングスラッシュの有無で「意図的なプレフィックス
 * 一致」と「厳密な完全一致」を明示的に書き分けることで、この事故を防ぐ。
 */
export function matchesSurfacePath(pathname: string, pattern: string): boolean {
  if (pattern.endsWith('/')) {
    return pathname.startsWith(pattern)
  }
  return pathname === pattern
}

/**
 * 指定した pathname + method の書き込みリクエストが、maintenance mode 中でも
 * ブロックを免除されるかどうかを判定する。
 *
 * 免除条件: surfaces の中に、maintenanceBehavior が EXEMPT_BEHAVIORS に含まれ、
 * methods に method を含み、かつ matchesSurfacePath が真になるエントリが
 * 1件でも存在すること。
 */
export function isMaintenanceWriteExempt(
  pathname: string,
  method: string,
  surfaces: readonly MaintenanceWriteSurface[]
): boolean {
  return surfaces.some(
    (surface) =>
      EXEMPT_BEHAVIORS.includes(surface.maintenanceBehavior) &&
      surface.methods.includes(method) &&
      matchesSurfacePath(pathname, surface.path)
  )
}
