import { type NextRequest, NextResponse } from 'next/server'
import { updateSession } from '@/lib/session-middleware'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { setSecurityHeaders, buildCsp } from '@/lib/security-headers'
import { ERROR_MESSAGES } from '@/lib/constants'
import { PRIVATE_NO_STORE_CACHE_CONTROL } from '@/lib/cache-control'
import { hasInvalidOverlayEventsStreamerId } from '@/lib/overlay-route-validation'
import { defaultLocale, locales, LOCALE_COOKIE_NAME, type Locale } from '@/i18n/config'
import { guardWrite } from '@/lib/maintenance/guard'
import { isMaintenanceWriteExempt, type MaintenanceWriteSurface } from '@/lib/maintenance/allowlist'
// #694 Stage 3: Edge Runtime では実行時の fs 読み込みができないため、write surface
// の棚卸し(config/maintenance-write-surfaces.json)は静的 import でバンドルに含める。
// JSON import は TS 上 maintenanceBehavior 等の文字列フィールドが（リテラル型では
// なく）ただの string に推論されるため、MaintenanceWriteSurface[] へ as で断定する。
// 実データが 'block' | 'allow' | 'redirect' | 'queue-during-maintenance' の4値・
// パスが '/api/' 始まりであることは tests/unit/maintenance-write-surfaces-schema.test.ts
// が実行時に検証しており、この cast は「型を偽っているだけ」にはならない。
import maintenanceWriteSurfacesJson from '../config/maintenance-write-surfaces.json'
import { logger } from '@/lib/logger'

const maintenanceWriteSurfaces = maintenanceWriteSurfacesJson as MaintenanceWriteSurface[]

// Issue #1980 Phase 1: isolate 起動マーカー（ブートマーカー）。
// 本番の cpuTimeMs 跳ね上がりが「新規 isolate の初回リクエスト」由来かを判別するため、
// モジュール評価時（= isolate 起動時にちょうど1回）に isolate 識別子と起動時刻を出す。
// matcher で除外される /robots.txt 等でも、OpenNext の worker.js が
// middleware/handler.mjs を静的 import して起動時に評価するため、
// 全リクエスト経路の cpuTimeMs と時系列で突合できる。
// isolateId は同時刻に複数 isolate が起動した場合のログ行の区別用。
// 起動コストへの影響を避けるため、追加 I/O や重い依存は行わず
// Workers 標準の crypto.randomUUID / Date のみを使う。
const isolateBootId = crypto.randomUUID()
logger.info('[IsolateBoot]', { isolateId: isolateBootId, bootedAt: new Date().toISOString() })

/** maintenance write block の対象となる HTTP メソッド（読み取り系は対象外）。 */
const MAINTENANCE_GUARDED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Keep this Edge Middleware entrypoint until the Cloudflare Proxy migration
// passes TwiCa's build and session/routing verification gates.
// Source of truth: docs/cloudflare-proxy-migration.md (#1321).

/**
 * Detect locale from request (cookie or Accept-Language header)
 * リクエストからロケールを検出（CookieまたはAccept-Languageヘッダー）
 */
function detectLocale(request: NextRequest): Locale {
  // Priority 1: Check cookie for user's saved preference
  // 優先度1: ユーザーの保存された設定をCookieから確認
  const localeCookie = request.cookies.get(LOCALE_COOKIE_NAME)?.value
  if (localeCookie && locales.includes(localeCookie as Locale)) {
    return localeCookie as Locale
  }

  // Priority 2: Check Accept-Language header
  // 優先度2: Accept-Languageヘッダーを確認
  const acceptLanguage = request.headers.get('accept-language')
  if (acceptLanguage) {
    const languages = acceptLanguage
      .split(',')
      .map((lang) => {
        const [code, qValue] = lang.trim().split(';q=')
        return {
          code: code.split('-')[0].toLowerCase(),
          quality: qValue ? parseFloat(qValue) : 1,
        }
      })
      .sort((a, b) => b.quality - a.quality)

    for (const lang of languages) {
      if (locales.includes(lang.code as Locale)) {
        return lang.code as Locale
      }
    }
  }

  // Priority 3: Fall back to default locale
  // 優先度3: デフォルトロケールにフォールバック
  return defaultLocale
}

// Paths excluded from global rate limiting (have their own rate limits)
// グローバルレート制限から除外するパス（独自のレート制限を持つ）
const RATE_LIMIT_EXCLUDED_PATHS = [
  '/api/auth/twitch/callback',
  '/api/twitch/eventsub',
  '/api/auth/twitch/login',
  // Issue #2039: /api/overlay/ 配下は全ルートが独自リミッター
  // (overlayEventsGet 120/分・overlayCardRankingGet 60/分、realtime-config は
  // edge キャッシュ対象) を持つため、global リミッターによる二重の KV
  // read-modify-write を除外する。overlay ポーリングが本番トラフィックの
  // 主成分であり、ここで KV op を半減させる。
  '/api/overlay/',
]

// Issue #906: Workers Cache でキャッシュする公開エンドポイント。
// middleware はこのパス以外の全レスポンスに private, no-store をデフォルト付与する
// （fail-closed）。キャッシュの最終決定権はルート側の Cache-Control にある
// （Next.js ではルートハンドラが middleware の後に実行され、ヘッダーを上書きできる）。
// つまり、ここに無いパスでもルートが public を設定すればキャッシュされるため、
// ルート側の public 設定とこの判定は常に同期させること。
// 機密情報を返さない・セッション非依存のエンドポイントのみを許可する。
// 警告: ここへ HTML を返すパスを追加してはならない。エッジキャッシュに nonce 付き
// CSP が焼き付き、キャッシュ HIT 中の全スクリプトが nonce 不一致でブロックされる
// （現状の対象は JSON のみで無害）。
const CACHEABLE_PUBLIC_PATHS = [
  /^\/api\/maintenance-status$/,
  /^\/api\/streamer\/[^/]+\/sound-settings$/,
  // Issue #1783 フェーズ2: オーバーレイが読むカスタムレアリティ表示スタイル。
  // sound-settings と同じくセッション非依存の JSON で、ルート側も s-maxage=1 を明示する。
  /^\/api\/streamer\/[^/]+\/rarity-styles$/,
  /^\/api\/overlay\/[^/]+\/realtime-config$/,
]

// Set-Cookie と public の共存方針 (#1334):
// cacheable public path 上でも updateSession はセッション異常時に
// Cookie 削除の Set-Cookie を返し得る（route 側は cookie を一切発行しない
// 契約。発行する route をこのリストへ追加してはならない）。
// Cloudflare Workers Cache は既定で Set-Cookie を含む応答をキャッシュしない
// ため、この同居は「その1回だけキャッシュを素通りする」挙動であり、
// セッション Cookie が edge cache へ焼き付く事故にはならない。
// この既定挙動への依存を方針として明文化する（docs/ARCHITECTURE.md
// 「Workers Cache」節も参照）。Cache API の cache.put 等で Set-Cookie を
// 強制保存する変更を入れた場合はこの前提が崩れるため、同時に見直すこと。

/**
 * #694 Stage 3: maintenance mode (off 以外) のとき、/api 配下の write メソッド
 * (POST/PUT/PATCH/DELETE) を一律ブロックする。
 *
 * 案B（オーナー決定）: allowlist 方式。config/maintenance-write-surfaces.json
 * で maintenanceBehavior が 'allow' または 'queue-during-maintenance' に
 * 登録されているパス+メソッドの組だけが免除される。新しい書き込み route を
 * 追加した際に allowlist への登録を忘れても、結果は「過剰ブロック」（安全側）
 * にしかならない。
 *
 * mode=off 不変条件（絶対に壊してはならない）: pathname が '/api/' 始まりかつ
 * method が MAINTENANCE_GUARDED_METHODS のいずれでもない場合（＝GET/HEAD等の
 * 大多数のリクエスト、および /api 以外の全リクエスト）は、getMaintenanceState()
 * を含む一切の追加処理をせず即座に null を返す。書き込み系メソッドであっても
 * allowlist に一致すれば guardWrite() を呼ばない（＝maintenance state を一切
 * 参照しない）ため、/api/auth/logout や /api/twitch/eventsub は mode に
 * 関わらず常時 getMaintenanceState() を呼ばずに通過する。allowlist 非該当の
 * 書き込みリクエストのみ guardWrite() を呼び、その内部でちょうど1回
 * getMaintenanceState() を呼ぶ（mode=off ならそこで null が返る）。
 *
 * export する理由: tests/unit/middleware-maintenance.test.ts から直接呼ぶため。
 * middleware() 全体は updateSession/checkRateLimit 等の外部 I/O 依存が重く
 * 単体テストに不向きなので、この判定ロジックだけを個別に検証できるようにする
 * （tests/unit/session-middleware.test.ts が updateSession を個別に import
 * してテストしているのと同じ方針）。
 */
export function checkMaintenanceWriteBlock(request: NextRequest): NextResponse | null {
  const { pathname } = request.nextUrl
  const method = request.method

  if (!pathname.startsWith('/api/') || !MAINTENANCE_GUARDED_METHODS.has(method)) {
    return null
  }

  if (isMaintenanceWriteExempt(pathname, method, maintenanceWriteSurfaces)) {
    return null
  }

  return guardWrite({ operation: `middleware:${method} ${pathname}` })
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // #694 Stage 3: 他の全処理（ロケール検出・rate limit・security headers 設定）
  // より先に評価する。rate limit の消費を避けるためと、ブロック対象なら
  // updateSession 等の余分な I/O を一切発生させないため。
  const maintenanceBlockResponse = checkMaintenanceWriteBlock(request)
  if (maintenanceBlockResponse) {
    return setSecurityHeaders(maintenanceBlockResponse, { pathname })
  }

  // Issue #657: 不正な streamerId をDBクエリへ渡す前に拒否する。
  // OBSブラウザソース等のURL末尾に文字列が混入しても、PostgreSQLの22P02を
  // 継続発生させず、入力エラーとして400を返す。
  if (hasInvalidOverlayEventsStreamerId(pathname)) {
    const errorResponse = NextResponse.json(
      { error: 'Invalid streamer ID' },
      { status: 400 }
    )
    // 早期 return は後段の fail-closed Cache-Control を通らないため、
    // エラー応答側でも明示的に保存禁止を宣言する（#1337）。
    errorResponse.headers.set('Cache-Control', PRIVATE_NO_STORE_CACHE_CONTROL)
    return setSecurityHeaders(errorResponse, { pathname })
  }

  // #836 項目5: リクエストごとに CSP nonce を発行する。
  // Next.js 16 は request の Content-Security-Policy ヘッダーから nonce を自動抽出し、
  // 自前スクリプトへ適用する（getScriptNonceFromHeader）。middleware で response の
  // CSP を設定するだけでなく、request ヘッダーにも設定することで、App Router の
  // サーバーコンポーネント（layout.tsx の Script コンポーネント）からも
  // x-nonce として参照できるようにする。
  // request は再構築せず、NextResponse.next({ request: { headers } }) の追加
  // ヘッダー経由でレンダラへ渡す（body 複製リスクを避ける公式パターン、#836）。
  const nonce = crypto.randomUUID()
  const requestHeaders = new Headers(request.headers)
  // CPU 課金抑制のため CSP 文字列はリクエストごとに 1 回だけ生成し、
  // request ヘッダーとレスポンスヘッダーの両方へ渡す（nonce 契約）。
  const csp = buildCsp(nonce, pathname)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = await updateSession(request, requestHeaders)
  // パスに基づいて適切なセキュリティヘッダーを設定
  // Set appropriate security headers based on the path
  setSecurityHeaders(response, { pathname, csp })

  // Detect and set locale for server components
  // サーバーコンポーネント用にロケールを検出・設定
  const locale = detectLocale(request)
  response.headers.set('x-locale', locale)

  // Issue #906: Workers Cache 有効化に伴う fail-closed デフォルト。
  // [cache] enabled = true は Worker 全体に効き、Cache-Control 未設定の GET は
  // heuristics でキャッシュされる（例: 200 → 2時間）。セッション依存・
  // リアルタイム性が重要なレスポンスが意図せずキャッシュされないよう、
  // 明示的にキャッシュを許可した公開パス以外には private, no-store を付与する。
  // キャッシュ許可パスはルート側で Cache-Control: public を設定する（この middleware は
  // ルートより先に実行されるため、ルートが最終的にヘッダーを上書きできる）。
  // 400/429/503 等は Workers Cache のヒューリスティック対象外だが、それには依存しない。
  // 後段の通常キャッシュ方針を通らず早期 return するレスポンスは、公開キャッシュ許可
  // パス上でも保存されないよう、自身で private, no-store を明示する。現在は不正 overlay
  // events の 400、global rate-limit の 429、maintenance guard の 503 がこの基準に従う（#1337）。
  // /api/overlay/ 配下は prefix ではなくエンドポイント単位で判定する。
  // events は OBS オーバーレイの 3 秒間隔ポーリングだが Cache-Control を設定
  // しないため、prefix 許可だと Workers Caching のヒューリスティック TTL
  // （200 → 2時間）でキャッシュされ、ガチャ結果の表示が最大2時間止まる。
  // realtime-config はルート側で `public, max-age=15, stale-while-revalidate=15` を
  // 明示する意図的な短 TTL キャッシュ対象（オーバーレイのバージョン確認）。
  // 警告: ここも HTML を返すパスを追加してはならない（CACHEABLE_PUBLIC_PATHS と
  // 同じ理由で nonce がエッジキャッシュに焼き付く）。
  const isCacheablePublicPath = CACHEABLE_PUBLIC_PATHS.some((pathPattern) =>
    pathPattern.test(pathname)
  )
  if (!isCacheablePublicPath) {
    response.headers.set('Cache-Control', PRIVATE_NO_STORE_CACHE_CONTROL)
  }

  // Ensure pages with session-dependent content are never cached
  // This is especially important for the top page which shows different content
  // based on login state
  if (pathname === '/' || pathname === '/dashboard') {
    response.headers.set('Cache-Control', 'private, no-cache, no-store, max-age=0, must-revalidate')
    response.headers.set('Pragma', 'no-cache')
    response.headers.set('Expires', '0')
  }

  // Apply global rate limiting only to API routes
  // グローバルレート制限はAPIルートにのみ適用
  if (pathname.startsWith('/api')) {
    // Skip global rate limiting for paths with their own rate limiting
    // to reduce CPU overhead from redundant checks
    // 独自のレート制限を持つパスはグローバルレート制限をスキップして
    // 冗長なチェックによるCPUオーバーヘッドを削減
    const isExcludedPath = RATE_LIMIT_EXCLUDED_PATHS.some(path => pathname.startsWith(path))

    if (!isExcludedPath) {
      const ip = getClientIp(request)
      const identifier = `global:${ip}`
      const rateLimitResult = await checkRateLimit(
        rateLimits.global,
        identifier
      )

      if (!rateLimitResult.success) {
        const errorResponse = NextResponse.json(
          { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
          {
            status: 429,
            headers: {
              // 429 は現在の Workers Cache heuristics では通常キャッシュ対象外だが、
              // 早期 return は上段の fail-closed response を返さないため明示的に保存禁止する。
              // cacheable public path でもレート制限応答だけは再利用させない（#1337）。
              'Cache-Control': PRIVATE_NO_STORE_CACHE_CONTROL,
              'X-RateLimit-Limit': String(rateLimitResult.limit),
              'X-RateLimit-Remaining': String(rateLimitResult.remaining),
              'X-RateLimit-Reset': String(rateLimitResult.reset),
            },
          }
        )

        return setSecurityHeaders(errorResponse, { pathname, csp })
      }
    }

    // CSRF validation is handled in individual route handlers
    // Middleware runs in Edge Runtime where cookies() is not available
    return response
  }

  return response
}

export const config = {
  // Exclude static files and assets from middleware to reduce CPU usage
  // 静的ファイルとアセットをミドルウェアから除外してCPU使用量を削減
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest\\.json|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf|eot)$).*)',
  ],
}
