/**
 * EventSub notification の KV 退避 (#694 Stage 4)
 *
 * maintenance mode（'off' 以外）のとき、EventSub webhook の notification メッセージを
 * DB へ書き込まず KV へ退避するための最小実装。呼び出し元（route.ts）は
 * mode !== 'off' のときだけこの関数を呼ぶ。リプレイ（退避データの再処理）は
 * このモジュールのスコープ外——退避データの形式だけリプレイ可能に設計し、
 * リプレイ手順自体は Stage 7 の runbook 更新で記載する。
 *
 * リプレイ実装者への注記（冪等性の前提）:
 * Twitch の EventSub は at-least-once 配送であり、加えて maintenance mode の
 * 切替タイミングと同時にリクエストが来た場合のレース（切替直前は通常処理、
 * 直後はこの退避処理、という揺れ）もありうる。そのため同一 messageId が
 * 複数キー（受信時刻違い）で退避される可能性を前提にすること。リプレイ側で
 * 独自に重複排除する必要はなく、DB 側の event_id UNIQUE 制約による冪等性
 * （ON CONFLICT (event_id) DO NOTHING、gacha.ts 参照。重複時は
 * 'Duplicate event' として静かにスキップされる）にそのまま乗ってよい。
 *
 * KV namespace の選定について:
 * 新規の専用 KV namespace を作るには Cloudflare 側（`wrangler kv:namespace create`）
 * の操作がオーナー権限で必要で、デプロイ前に済ませておく必要がある。maintenance
 * mode は既定で 'off' であり、そのときはこのモジュールのコードパスに一切入らない
 * （呼び出し側が mode !== 'off' のときだけ呼ぶ）。「フラグ未設定なら使われない
 * コード」のためだけに新しいインフラ依存（専用 namespace 作成・wrangler.toml
 * 更新・デプロイ）を先回りして増やすのは YAGNI に反する。そのため既存の
 * RATE_LIMIT_KV バインディング（wrangler.toml）をキープレフィックス
 * `maintenance:eventsub:` で分離して共用する。将来的に専用 namespace に
 * 分けたくなった場合は KV_BINDING_NAME を差し替えるだけで済むよう、
 * バインディング名をこの1箇所に集約している。
 */
import { logger } from '@/lib/logger.server'
import type { MaintenanceState } from './state'

/** 共用する KV バインディング名。専用 namespace に切り替える際はここだけ変更すればよい。 */
const KV_BINDING_NAME = 'RATE_LIMIT_KV'

/**
 * 退避データのキープレフィックス。RATE_LIMIT_KV 内で既に使われている
 * rate limit 用キー（`ratelimit:*`、src/lib/rate-limit.ts 参照）と
 * 名前空間が衝突しないよう分離する。
 *
 * 相互参照（ドリフト防止）: workers/error-reporter/src/index.ts の
 * backlog 監視（EVENTSUB_PARK_KEY_PREFIX / EVENTSUB_PARK_RECEIVED_AT_PATTERN）が
 * このプレフィックスと下の buildParkedEventSubKey のキー組み立てを、KV値を
 * 読まずキー名だけでパースできる前提で独立に再実装している（当該ワーカーは
 * @opennextjs/cloudflare 等 Next.js 専用の依存を持つこのモジュールを直接
 * import できないため）。このプレフィックスやキー形式（区切り文字・時刻
 * フォーマット）を変更したら、必ずワーカー側の実装も追従して変更すること。
 *
 * ドリフトの機械的検知（Fable レビュー Major-3 対応）: このコメントでの相互参照
 * だけでは実装がドリフトしてもテストは気づけない。そのため KEY_PREFIX と
 * buildParkedEventSubKey を export し、tests/unit/error-reporter-worker.test.ts
 * の契約テストで「worker 側のプレフィックス定数・パーサが、この export された
 * 本家の値・関数が生成するキーと実際に一致するか」を検証する
 * （worker パッケージ自体は import できなくても、テストファイルは両方を
 * import できる）。
 */
export const KEY_PREFIX = 'maintenance:eventsub:'

/**
 * 退避キー名を組み立てる。プレフィックス・区切り文字・フィールド順序の
 * 唯一のソース（parkEventSubNotification もこれを使う。以前は同じ式を
 * 関数内にインライン展開しており、export された定数と実際に使われる組み立て
 * ロジックが分離しうる余地があったため、Major-3 対応の一環として関数化した）。
 */
export function buildParkedEventSubKey(receivedAt: string, messageId: string): string {
  return `${KEY_PREFIX}${receivedAt}:${messageId}`
}

/**
 * 退避データの TTL（秒）。7日間。
 *
 * 選定理由:
 * - リプレイ前に消えると復旧不能（データロス）になるため、maintenance window の
 *   想定継続時間（cutover作業は通常数時間〜長くて1日程度）に対して十分な余裕を持たせる。
 * - 一方で TTL 無し（無期限）にすると、リプレイ手順の実行を運用者が失念した場合や
 *   maintenance mode が想定より長期化した場合に KV ストレージが無制限に増え続ける
 *   （課金・運用上のリスク）。また視聴者の Twitch ユーザーIDやチャンネルポイント
 *   償還情報を含むデータを無期限に保持し続けることはデータ最小化の観点でも
 *   望ましくない。
 * - 7日は「通常の cutover 作業が長引いても発見・対応できる」実務的な余裕と、
 *   「際限なく残り続けない」の両方を満たすラウンドナンバーとして選んだ
 *   （issue #694 側に具体的な想定継続期間の指定はないため、この値は実際の
 *   運用実績を見て Stage 7 の runbook 整備時に見直す前提とする）。
 */
const PARK_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Cloudflare Workers KV namespace の最小インターフェース。
 * r2-client.ts の R2BucketLike と同じ方針: @cloudflare/workers-types に
 * 依存せず、実際に使うメソッドだけを最小定義する。
 *
 * Issue #787 Stage 2: リプレイ機構の実装に伴い、退避時の put に加えて
 * 一覧取得・個別取得・削除の3メソッドを追加。型は実際の Cloudflare Workers KV
 * API（list/get/delete）に合わせている。
 */
interface KVNamespaceLike {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  /**
   * キー一覧を取得する。`list_complete: false` の場合は返却された `cursor` を
   * 次回呼び出しに渡すことで続きを取得できる（Cloudflare Workers KV の
   * ページネーション仕様どおり）。
   */
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[]
    list_complete: boolean
    cursor?: string
  }>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

/**
 * KV へ退避される1件のレコード形式（Issue #787 Stage 2）。
 * parkEventSubNotification が保存する匿名オブジェクトの構造をそのまま型定義した
 * だけで、フィールドの追加・変更は行っていない。リプレイ側（list/get）が
 * 型安全にレコードを扱えるようにするための export。
 */
export interface ParkedEventSubRecord {
  messageId: string
  subscriptionType: string
  payload: unknown
  receivedAt: string
  maintenanceMode: MaintenanceState['mode']
  maintenanceOperationId: MaintenanceState['operationId']
}

/** parkEventSubNotification に渡す入力。 */
export interface ParkEventSubNotificationInput {
  /** Twitch-Eventsub-Message-Id ヘッダーの値。KV キーとリプレイ時の相関に使う。 */
  messageId: string
  /**
   * EventSub notification の生 payload（`{ subscription, event, ... }` 全体、
   * JSON.parse 済み）。リプレイ時に handleRedemption / handleRaidNotification
   * 相当の再実行に必要な情報をすべて含む。
   */
  payload: unknown
  /** ログ・将来のリプレイ時フィルタリング用に個別保持する subscription type。 */
  subscriptionType: string
  /** 退避時点の maintenance state。operationId をリプレイ時の相関ログに残すため。 */
  maintenanceState: MaintenanceState
}

/**
 * Cloudflare Workers 環境から RATE_LIMIT_KV バインディングを取得する。
 * next dev 等 Workers 外の環境、または binding 未設定時は null を返す
 * （r2-client.ts の getR2Binding と同じフォールバックパターン）。
 */
async function getMaintenanceKvBinding(): Promise<KVNamespaceLike | null> {
  try {
    // ローカル開発時に @opennextjs/cloudflare をバンドルしないよう動的 import
    // （db/client.ts, r2-client.ts と同じ理由）
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const { env } = await getCloudflareContext({ async: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binding = (env as any)[KV_BINDING_NAME] as KVNamespaceLike | undefined
    return binding ?? null
  } catch {
    // Cloudflare Workers 環境ではない（next dev / Node / テスト）
    return null
  }
}

/**
 * payload（`{ subscription, event, ... }`）から `event.user_input` を除去した
 * コピーを返す（issue #695代替のKVベース部分改善、項目3: payload最小化）。
 *
 * `user_input` はチャンネルポイント報酬に紐づく視聴者の自由入力テキストで、
 * `handleRedemption`/`handleRaidNotification`（src/lib/services/
 * eventsub-redemption.ts）のどちらも参照しておらず、リプレイ処理に不要
 * （grep で無参照を確認済み）。他のフィールド（`user_id`/`user_name`/
 * `reward.id`等）はhandlerが受け取る型が宣言している形を保つために残す
 * （一部フィールド、例えば`user_login`は実際には未使用だが、fail-safe設計
 * （handlerが期待する形をそのまま維持する）を優先し、個別に精査して削る
 * ことはしない。Fableレビューで「削れるのはuser_inputのみ、他を削ると
 * fail-safe設計を壊すリスクの方が大きい」と判定済み）。TTL 7日のKVに
 * 視聴者の自由入力テキストを保持し続ける期間を減らす、最小限のPII削減。
 *
 * `payload`は`unknown`（外部由来のJSONをそのまま受け取る型）なので、
 * 期待する形（`event`がオブジェクト）でない場合は何もせず元のpayloadを
 * そのまま返す（防御的、fail-safe。未知のsubscription typeも全量退避する
 * という既存方針を壊さないため、構造チェックで弾いたり例外を投げたりしない）。
 * 元の`payload`オブジェクト・`event`オブジェクトは変更しない（呼び出し元が
 * まだ参照している可能性があるため、分割代入で新しいオブジェクトを作り、
 * 元のオブジェクトへの`delete`は行わない）。
 */
function stripUserInputFromPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  const { event, ...rest } = payload as Record<string, unknown>
  if (typeof event !== 'object' || event === null || !('user_input' in event)) {
    return payload
  }
  const { user_input: _userInput, ...eventWithoutUserInput } = event as Record<string, unknown>
  return { ...rest, event: eventWithoutUserInput }
}

/**
 * EventSub notification を KV へ退避する。
 *
 * 戻り値は「退避に成功したか」を示すが、呼び出し側（route.ts）は成功・失敗の
 * どちらでも Twitch には 2xx を返し、DB 書き込みは行わない設計にしている。
 * 理由: KV 書き込みに失敗する状況（KV障害等）で 500 を返すと Twitch の
 * 自動リトライに賭けることになるが、そのリトライも同じ KV 障害下では
 * 恐らく失敗し続ける一方で、5xx の連続はこの Stage 全体の前提である
 * 「Twitch への 5xx は subscription revoke 判定材料になるため厳禁」という
 * 制約に抵触するリスクがある。そのため「退避もできない = データロスを記録して
 * 前進する」を選び、2xx を返す判断を route.ts 側で行っている
 * （代替案・トレードオフは実装報告に記載）。
 *
 * @returns 退避に成功したら true。KV バインディング未取得・put 失敗のいずれも false。
 */
export async function parkEventSubNotification(
  input: ParkEventSubNotificationInput
): Promise<boolean> {
  const receivedAt = new Date().toISOString()
  // ISO8601 の受信時刻をキーに含めることで、KV list 時に受信時刻順でソートされる
  // （リプレイ時の処理順の目安になる）。messageId も付与して同一ミリ秒内の
  // 複数通知でもキーが衝突しないようにする。
  const key = buildParkedEventSubKey(receivedAt, input.messageId)

  const record: ParkedEventSubRecord = {
    messageId: input.messageId,
    subscriptionType: input.subscriptionType,
    payload: stripUserInputFromPayload(input.payload),
    receivedAt,
    maintenanceMode: input.maintenanceState.mode,
    maintenanceOperationId: input.maintenanceState.operationId,
  }

  try {
    const kv = await getMaintenanceKvBinding()
    if (!kv) {
      // logger.error に格上げする理由: これは「ガチャ redemption を退避できず
      // 消失した」というデータロスであり、警告ログの監視をオペレーターに
      // 期待する warn では検知漏れのリスクがある。logger.error は
      // errors テーブル記録 → Cron Worker (twica-error-reporter) による
      // GitHub Issue 自動起票の経路に乗るため（logger.ts 参照）、オペレーターが
      // 能動的にログを見ていなくても検知できる。検索可能なタグ
      // （[maintenance:eventsub] ...）はそのままこのログの grep 起点として使える。
      // Stage 7 でこの経路にもとづくアラート/runbook の追加検討を行う想定。
      logger.error(
        `[maintenance:eventsub] KV binding unavailable, dropping message id=${input.messageId} type=${input.subscriptionType} mode=${input.maintenanceState.mode}`
      )
      return false
    }

    await kv.put(key, JSON.stringify(record), { expirationTtl: PARK_TTL_SECONDS })

    // 検索可能なタグ付きログ（[maintenance:eventsub] parked ...）。退避「成功」件数の
    // 集計はこのログをベースに Stage 7 で行う想定（失敗側のアラート設定は下記参照）。
    logger.info(
      `[maintenance:eventsub] parked message id=${input.messageId} type=${input.subscriptionType} mode=${input.maintenanceState.mode}`
    )
    return true
  } catch (error) {
    // logger.error に格上げする理由は上の KV binding unavailable ケースと同じ:
    // ガチャ収入相当のデータロスをオペレーターの手動ログ監視に頼らず検知するため。
    logger.error(
      `[maintenance:eventsub] failed to park message id=${input.messageId} type=${input.subscriptionType} mode=${input.maintenanceState.mode} - data lost`,
      { error: error instanceof Error ? error.message : String(error) }
    )
    return false
  }
}

/** listParkedEventSubNotifications に渡す入力。 */
export interface ListParkedEventSubNotificationsInput {
  /** 前回呼び出しで返却された cursor。続きから一覧取得する場合に指定する。 */
  cursor?: string
  /** 1回のKV list呼び出しで取得する最大件数。省略時はKV既定値に従う。 */
  limit?: number
}

/** listParkedEventSubNotifications の戻り値。 */
export interface ListParkedEventSubNotificationsResult {
  /** 取得できたレコード一覧（壊れたJSONのエントリはスキップ済み）。 */
  entries: Array<{ key: string; record: ParkedEventSubRecord }>
  /** 続きがある場合に次回呼び出しへ渡す cursor。 */
  cursor?: string
  /** true の場合、これ以上のエントリは存在しない（KV list の list_complete をそのまま反映）。 */
  listComplete: boolean
}

/**
 * KV へ退避された EventSub notification を一覧取得する（Issue #787 Stage 2）。
 *
 * 個別エントリの壊れたJSON（理論上は起こり得ないはずだが、KV書き込み中断等の
 * 万一のケースを防御的に想定）は logger.error でログしてスキップし、一覧取得
 * 全体は継続する。1件の破損データで全体のリプレイ処理が止まってしまう方が
 * 実害が大きいため（parkEventSubNotification と同様、データ操作不能を
 * オペレーターに検知させる目的で warn ではなく error を使う）。
 *
 * KV バインディング自体が取得できない場合（Workers外環境やbinding未設定）は
 * parkEventSubNotification の KV binding unavailable ケースと同じ理由で
 * logger.error し、空の結果を返す（呼び出し元がクラッシュしないようfail-safe）。
 */
export async function listParkedEventSubNotifications(
  input: ListParkedEventSubNotificationsInput
): Promise<ListParkedEventSubNotificationsResult> {
  const kv = await getMaintenanceKvBinding()
  if (!kv) {
    logger.error(
      `[maintenance:eventsub] KV binding unavailable, cannot list parked notifications`
    )
    return { entries: [], cursor: undefined, listComplete: true }
  }

  const listResult = await kv.list({
    prefix: KEY_PREFIX,
    cursor: input.cursor,
    limit: input.limit,
  })

  const entries: Array<{ key: string; record: ParkedEventSubRecord }> = []
  for (const { name: key } of listResult.keys) {
    const raw = await kv.get(key)
    if (raw === null) {
      // list と get の間でTTL失効等により消えた可能性がある。エラーではなく
      // 単純にスキップする（データ破損ではないため logger.error は不要）。
      continue
    }

    try {
      const record = JSON.parse(raw) as ParkedEventSubRecord
      entries.push({ key, record })
    } catch (error) {
      // 破損データとしてログし、このエントリだけスキップして一覧取得全体は継続する。
      logger.error(
        `[maintenance:eventsub] failed to parse parked record - corrupted data, skipping key=${key}`,
        { error: error instanceof Error ? error.message : String(error) }
      )
    }
  }

  return {
    entries,
    cursor: listResult.cursor,
    listComplete: listResult.list_complete,
  }
}

/**
 * KV へ退避された1件の EventSub notification を削除する（Issue #787 Stage 2）。
 * リプレイ成功・skip確定後にリプレイ側から呼ばれる。
 *
 * KV バインディング取得に失敗した場合は logger.warn のみに留める（parkと違い
 * データロスではなく「削除できなかった」だけであり、KEY_PREFIX の TTL（7日）で
 * いずれ自動的に消えるため、parkEventSubNotification 相当の error 格上げは不要）。
 */
export async function deleteParkedEventSubNotification(key: string): Promise<void> {
  const kv = await getMaintenanceKvBinding()
  if (!kv) {
    logger.warn(
      `[maintenance:eventsub] KV binding unavailable, cannot delete parked notification key=${key}`
    )
    return
  }

  await kv.delete(key)
}
