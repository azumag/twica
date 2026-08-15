import { refreshTwitchToken, TwitchTokenRefreshError, type TwitchTokens } from './auth';
import { logger } from '@/lib/logger.server';
// -----------------------------------------------------------------------------
// Twitch credential・scope・BOT設定はPlanetScale/Drizzleの単一経路。
// getDb()は接続回復を有効にするためwithDbRetryのqueryFn内で取得する。
// timestamptzはdb/client.tsでISO 8601へ正規化され、期限判定はnew Date()経由。
// -----------------------------------------------------------------------------
import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';

import { withDbRetry } from '@/lib/db/retry';
import { isPgMissingColumnError, isPgMissingTableError } from '@/lib/db/errors';
import {
  streamers as streamersTable,
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  twitchBotAccounts as twitchBotAccountsTable,
  users as usersTable,
} from '@/lib/db/schema';

export class TwitchTokenError extends Error {
  constructor(
    message: string,
    public readonly code: 'NO_TOKEN' | 'REFRESH_FAILED' | 'DATABASE_ERROR' | 'USER_NOT_FOUND',
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'TwitchTokenError';
  }
}

/**
 * TwitchTokenRefreshError が持つ診断情報のうち、ログへ出しても安全な部分だけを
 * 抽出する(Issue #653/#670/#654/#655)。
 *
 * これらのIssueは、Twitchトークンrefresh失敗のauto-generated bug reportに
 * HTTP status・エラー種別が一切記録されておらず、恒久エラー(無効なrefresh
 * token等)と一時エラー(429/5xx/network)を区別できないため、根拠のある
 * retry/reauth設計に着手できないと判定されていた。TwitchTokenRefreshError
 * 自体は既に response.status を保持している(auth.ts参照。応答本文は
 * プロバイダが入力値を反射し得るため意図的に保持しない設計)ため、ここでは
 * 単にその値をログ経路へ橋渡しするだけで、新しい機密情報は増えない。
 *
 * 戻り値をlogger呼び出しへspreadする用途のみを想定するため、該当しない
 * errorに対しては空オブジェクトを返す(該当フィールドがログへ出ないだけで、
 * 呼び出し側のログ呼び出し自体を分岐させる必要をなくす)。
 */
function twitchTokenRefreshFailureContext(error: unknown): {
  refreshStatus?: number;
  refreshErrorKind?: TwitchTokenRefreshError['kind'];
  refreshRetryable?: boolean;
} {
  if (!(error instanceof TwitchTokenRefreshError)) return {};
  return {
    refreshStatus: error.status,
    refreshErrorKind: error.kind,
    refreshRetryable: error.retryable,
  };
}

// Workersのfetch/DB I/Oはrequest contextに所属するため、pending Promiseをmodule
// scopeへ保存して別requestからawaitしてはいけない。同じcredential行の短期leaseを
// DB時刻で取得し、Twitch endpointを呼ぶrequestをisolate横断で1件に絞る。外部APIは
// transaction外で呼び、保存時はlease IDをfencing tokenとして期限切れ旧leaderの
// 上書きも拒否する。Twitch公式の「refreshは1 threadで実施して配布」とCloudflare/
// Hyperdriveのrequest-scope制約を同時に満たす境界である。
const TWITCH_REFRESH_LEASE_TTL_SECONDS = 40
const TWITCH_REFRESH_SAVE_LEASE_TTL_SECONDS = 60
// Twitch token refreshの最大13秒より最小累計（約14.85秒）を長くし、遅いleaderの
// 保存をfollowersが観測できるようにする。一方、25% jitter込みの最大累計は約18.6秒
// なので、Cloudflare waitUntilの30秒内にchat送信（最大約9.75秒）の余白も残す。
// 無制限pollやrequest context外の共有Promiseは使わない。
const REFRESH_WINNER_POLL_DELAYS_MS = [
  0,
  100,
  250,
  500,
  1_000,
  1_500,
  2_000,
  2_500,
  3_000,
  3_000,
  1_000,
]

type RefreshLeaseOptions = {
  acquire: (leaseId: string) => Promise<boolean>
  release: (leaseId: string) => Promise<void>
  readWinner: () => Promise<string | null>
  refreshAndPersist: (leaseId: string) => Promise<string>
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

async function waitForRefreshWinner(
  readWinner: () => Promise<string | null>,
): Promise<string | null> {
  // DBのLISTEN/NOTIFYはHyperdriveのpooled接続と相性が悪いため使わない。通常は
  // 最初の数百msでwinnerを観測し、遅い場合も約18.6秒・最大11 readに制限する。
  // 同時followersが同じ瞬間にSELECTしないよう各待機へ最大25%のjitterを加え、
  // 51並行時のDB負荷とユーザー待ち時間をboundedにする。
  for (const delayMs of REFRESH_WINNER_POLL_DELAYS_MS) {
    if (delayMs > 0) {
      const jitterMs = Math.floor(Math.random() * Math.max(1, Math.floor(delayMs / 4)))
      await waitForDelay(delayMs + jitterMs)
    }
    const winner = await readWinner()
    if (winner) return winner
  }
  return null
}

async function runWithRefreshLease(options: RefreshLeaseOptions): Promise<string> {
  const leaseId = crypto.randomUUID()
  const acquired = await options.acquire(leaseId)

  if (!acquired) {
    const winner = await waitForRefreshWinner(options.readWinner)
    if (winner) return winner
    // leaseを奪ってOAuthを重複実行しない。leader異常終了時はDB時刻で40秒後に
    // 次の通常requestが回復できるため、このrequestは上限付き待機後に失敗する。
    throw new Error('Twitch token refresh is already in progress')
  }

  const releaseBestEffort = async () => {
    try {
      await options.release(leaseId)
    } catch {
      // token保存成功時は同じUPDATEでleaseを解除済み。callback winner等で残った
      // leaseの明示解除に失敗しても期限で回復し、利用可能なtokenを失敗扱いしない。
    }
  }

  try {
    const accessToken = await options.refreshAndPersist(leaseId)
    await releaseBestEffort()
    return accessToken
  } catch (error) {
    // OAuth callback等が並行して新しいpairを保存した場合だけwinnerを採用する。
    // winnerが無い失敗でもowner条件付きでleaseを解除する。既に待機中のfollowersは
    // 再取得せず失敗するため同一波のstampedeは起こさず、次の通常requestだけが
    // 直ちに回復を試せる。期限まで40秒間すべての通知を拒否する窓を残さない。
    const winner = await options.readWinner()
    await releaseBestEffort()
    if (winner) {
      return winner
    }
    throw error
  }
}

async function acquireUserRefreshLease(
  twitchUserId: string,
  attemptedRefreshToken: string,
  leaseId: string,
): Promise<boolean> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb()
      return db
        .update(usersTable)
        .set({
          twitch_refresh_lease_id: leaseId,
          // DB時刻だけで取得可否と期限を決め、Worker間のclock skewを排除する。
          twitch_refresh_lease_expires_at:
            sql`now() + (${TWITCH_REFRESH_LEASE_TTL_SECONDS} * interval '1 second')`,
        })
        .where(and(
          eq(usersTable.twitch_user_id, twitchUserId),
          eq(usersTable.twitch_refresh_token, attemptedRefreshToken),
          // 初回read後に別request/callbackが有効期限だけ更新した場合も、古い判定で
          // OAuthを再実行しない。取得可否はWorker時計ではなくDB時刻で再検証する。
          lte(usersTable.twitch_token_expires_at, sql`now()`),
          or(
            isNull(usersTable.twitch_refresh_lease_id),
            isNull(usersTable.twitch_refresh_lease_expires_at),
            lte(usersTable.twitch_refresh_lease_expires_at, sql`now()`),
            // 接続断後のwithDbRetryは同じUUIDで再実行するため冪等に成功させる。
            eq(usersTable.twitch_refresh_lease_id, leaseId),
          ),
        ))
        .returning({ leaseId: usersTable.twitch_refresh_lease_id })
    },
    'refreshTwitchAccessToken(acquire lease)',
    { idempotent: true },
  )
  return rows[0]?.leaseId === leaseId
}

async function releaseUserRefreshLease(
  twitchUserId: string,
  leaseId: string,
): Promise<void> {
  await withDbRetry(
    async () => {
      const { db } = await getDb()
      await db
        .update(usersTable)
        .set({
          twitch_refresh_lease_id: null,
          twitch_refresh_lease_expires_at: null,
        })
        .where(and(
          eq(usersTable.twitch_user_id, twitchUserId),
          eq(usersTable.twitch_refresh_lease_id, leaseId),
        ))
    },
    'refreshTwitchAccessToken(release lease)',
    { idempotent: true },
  )
}

async function renewUserRefreshLeaseForSave(
  twitchUserId: string,
  attemptedRefreshToken: string,
  leaseId: string,
): Promise<boolean> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb()
      return db
        .update(usersTable)
        .set({
          // OAuth（最大約28秒）の後に保存専用の余裕を取り直す。DB接続の
          // connect_timeout 10秒 × 最大4試行 + backoffを60秒内へ収める。
          twitch_refresh_lease_expires_at:
            sql`now() + (${TWITCH_REFRESH_SAVE_LEASE_TTL_SECONDS} * interval '1 second')`,
        })
        .where(and(
          eq(usersTable.twitch_user_id, twitchUserId),
          eq(usersTable.twitch_refresh_token, attemptedRefreshToken),
          eq(usersTable.twitch_refresh_lease_id, leaseId),
        ))
        .returning({ leaseId: usersTable.twitch_refresh_lease_id })
    },
    'refreshTwitchAccessToken(renew lease for save)',
    { idempotent: true },
  )
  return rows[0]?.leaseId === leaseId
}

async function acquireBotRefreshLease(
  accountId: string,
  attemptedRefreshToken: string,
  leaseId: string,
): Promise<boolean> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb()
      return db
        .update(twitchBotAccountsTable)
        .set({
          twitch_refresh_lease_id: leaseId,
          twitch_refresh_lease_expires_at:
            sql`now() + (${TWITCH_REFRESH_LEASE_TTL_SECONDS} * interval '1 second')`,
        })
        .where(and(
          eq(twitchBotAccountsTable.id, accountId),
          eq(twitchBotAccountsTable.twitch_refresh_token, attemptedRefreshToken),
          lte(twitchBotAccountsTable.twitch_token_expires_at, sql`now()`),
          or(
            isNull(twitchBotAccountsTable.twitch_refresh_lease_id),
            isNull(twitchBotAccountsTable.twitch_refresh_lease_expires_at),
            lte(twitchBotAccountsTable.twitch_refresh_lease_expires_at, sql`now()`),
            eq(twitchBotAccountsTable.twitch_refresh_lease_id, leaseId),
          ),
        ))
        .returning({ leaseId: twitchBotAccountsTable.twitch_refresh_lease_id })
    },
    'getBotAccountForChat(acquire refresh lease)',
    { idempotent: true },
  )
  return rows[0]?.leaseId === leaseId
}

async function renewBotRefreshLeaseForSave(
  accountId: string,
  attemptedRefreshToken: string,
  leaseId: string,
): Promise<boolean> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb()
      return db
        .update(twitchBotAccountsTable)
        .set({
          twitch_refresh_lease_expires_at:
            sql`now() + (${TWITCH_REFRESH_SAVE_LEASE_TTL_SECONDS} * interval '1 second')`,
        })
        .where(and(
          eq(twitchBotAccountsTable.id, accountId),
          eq(twitchBotAccountsTable.twitch_refresh_token, attemptedRefreshToken),
          eq(twitchBotAccountsTable.twitch_refresh_lease_id, leaseId),
        ))
        .returning({ leaseId: twitchBotAccountsTable.twitch_refresh_lease_id })
    },
    'getBotAccountForChat(renew refresh lease for save)',
    { idempotent: true },
  )
  return rows[0]?.leaseId === leaseId
}

async function releaseBotRefreshLease(
  accountId: string,
  leaseId: string,
): Promise<void> {
  await withDbRetry(
    async () => {
      const { db } = await getDb()
      await db
        .update(twitchBotAccountsTable)
        .set({
          twitch_refresh_lease_id: null,
          twitch_refresh_lease_expires_at: null,
        })
        .where(and(
          eq(twitchBotAccountsTable.id, accountId),
          eq(twitchBotAccountsTable.twitch_refresh_lease_id, leaseId),
        ))
    },
    'getBotAccountForChat(release refresh lease)',
    { idempotent: true },
  )
}

async function markBotRefreshLeaseFailed(
  accountId: string,
  attemptedRefreshToken: string,
  leaseId: string,
): Promise<void> {
  await withDbRetry(
    async () => {
      const { db } = await getDb()
      await db
        .update(twitchBotAccountsTable)
        .set({
          status: 'error',
          last_error: 'token_refresh_failed',
          twitch_refresh_lease_id: null,
          twitch_refresh_lease_expires_at: null,
        })
        .where(and(
          eq(twitchBotAccountsTable.id, accountId),
          eq(twitchBotAccountsTable.twitch_refresh_token, attemptedRefreshToken),
          eq(twitchBotAccountsTable.twitch_refresh_lease_id, leaseId),
          eq(twitchBotAccountsTable.status, 'active'),
        ))
    },
    'getBotAccountForChat(save fenced error status)',
    { idempotent: true },
  )
}

function shouldDisableBotCredential(error: unknown): boolean {
  // Twitch が資格情報の失効を示す400/401だけを再認証対象にする。403/404/501等は
  // client設定・WAF・上流機能の問題でも起こるため、単にretry対象外という理由だけで
  // BOTを無効化してはいけない（retry方針とcredential失効判定は別の責務）。
  // 522/network/壊れた2xx応答やDB保存障害でstatus='error'にすると、取得クエリの
  // active filterから外れ、上流復旧後も自動再試行できなくなる。
  return error instanceof TwitchTokenRefreshError
    && error.kind === 'http'
    && (error.status === 400 || error.status === 401);
}

async function readUserRefreshWinner(
  twitchUserId: string,
): Promise<string | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            twitch_access_token: usersTable.twitch_access_token,
          })
          .from(usersTable)
          .where(and(
            eq(usersTable.twitch_user_id, twitchUserId),
            // Twitchは成功時もrefresh tokenを同じ値で返し得る。token値の変化ではなく、
            // DB時刻で有効なaccess tokenが保存済みかをwinnerの唯一の条件にする。
            gt(usersTable.twitch_token_expires_at, sql`now()`),
          ))
          .limit(1);
      },
      'refreshTwitchAccessToken(read CAS winner)',
      { idempotent: true },
    );
    const winner = rows[0];
    return winner?.twitch_access_token ?? null;
  } catch {
    // 元のOAuth/保存エラーをDB再確認エラーで置き換えない。API境界が既存の
    // REFRESH_FAILEDとして扱い、token値や下位応答本文もログへ露出させない。
    return null;
  }
}

async function readBotRefreshWinner(
  accountId: string,
): Promise<string | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            twitch_access_token: twitchBotAccountsTable.twitch_access_token,
          })
          .from(twitchBotAccountsTable)
          .where(and(
            eq(twitchBotAccountsTable.id, accountId),
            gt(twitchBotAccountsTable.twitch_token_expires_at, sql`now()`),
          ))
          .limit(1);
      },
      'getBotAccountForChat(read CAS winner)',
      { idempotent: true },
    );
    const winner = rows[0];
    return winner?.twitch_access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * getTwitchAccessToken の pg 直結実装 (#572)
 *
 * - users を twitch_user_id で 1 行取得。UNIQUE 制約（migration 00001）により
 *   最大 1 行なので、LIMIT 1 + rows[0] ?? null とする。
 * - トークン/lease列のmigrationよりコードが先行する窓ではSQLSTATE 42703を
 *   DATABASE_ERRORとして上位へ伝える。nullへ落とすと恒久credential欠落と
 *   区別できず、chat outboxが再試行せずDLQ化するためである。
 * - 取得後の期限判定は既存実装と同一ロジック。期限切れ時の refreshTwitchAccessToken は
 *   共有関数のまま呼ぶ。
 */
async function getTwitchAccessTokenPg(twitchUserId: string): Promise<string | null> {
  let user:
    | {
        twitch_access_token: string | null;
        twitch_refresh_token: string | null;
        twitch_token_expires_at: string | null;
      }
    | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            twitch_access_token: usersTable.twitch_access_token,
            twitch_refresh_token: usersTable.twitch_refresh_token,
            twitch_token_expires_at: usersTable.twitch_token_expires_at,
          })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      'twitch token fetch',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    user = rows[0] ?? null;
  } catch (dbError) {
    if (isPgMissingColumnError(dbError)) {
      logger.warn('Twitch token columns are missing; denying token access', {
        twitchUserId,
        error: dbError,
      });
      throw new TwitchTokenError(
        'Twitch token schema is unavailable',
        'DATABASE_ERROR',
        dbError instanceof Error ? dbError : undefined,
      );
    }
    logger.warn('Database error fetching user tokens', { twitchUserId, error: dbError });
    throw new TwitchTokenError(
      'Failed to fetch user tokens from database',
      'DATABASE_ERROR',
      dbError instanceof Error ? dbError : undefined
    );
  }

  if (!user || !user.twitch_access_token || !user.twitch_refresh_token) {
    return null;
  }

  if (!user.twitch_token_expires_at) {
    return null;
  }

  const expiresAt = new Date(user.twitch_token_expires_at);
  if (isNaN(expiresAt.getTime())) {
    return null;
  }

  const now = new Date();
  if (expiresAt > now) {
    return user.twitch_access_token;
  }

  try {
    return await refreshTwitchAccessToken(twitchUserId, user.twitch_refresh_token);
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      // migration/app workflowは独立しており、lease列が先行配備されていない窓が
      // あり得る。旧CAS-onlyへ戻すと並行OAuth上限を再発させるため、OAuthを呼ばず
      // token access自体はfail-closedにする。ただしnullは「credentialが恒久的に
      // 無い」という契約なので使わず、上位outboxが再試行できるDATABASE_ERRORへ写す。
      logger.warn('Twitch token columns are missing; denying token access', {
        twitchUserId,
        error,
      })
      throw new TwitchTokenError(
        'Twitch token refresh schema is unavailable',
        'DATABASE_ERROR',
        error instanceof Error ? error : undefined,
      )
    }
    throw error
  }
}

export async function getTwitchAccessToken(twitchUserId: string): Promise<string | null> {
  // 読み取りから期限切れ時のCAS更新までPlanetScaleの単一経路で完結させる。
  return getTwitchAccessTokenPg(twitchUserId);
}

export interface BotChatAccount {
  accountId: string;
  senderId: string;
  username: string | null;
  displayName: string | null;
  accessToken: string;
  ownerType: 'streamer' | 'system';
}

/**
 * BOT送信者の解決結果。nullだけでは「未設定」と「設定済みだが一時障害」と
 * 「再認証が必要な恒久credential欠落」を区別できず、後段が本人scope不足へ
 * 誤分類するため、chat outbox向けには判別共用体を公開する。
 */
export type BotChatAccountResolution =
  | { status: 'available'; account: BotChatAccount }
  | { status: 'not-configured' }
  | { status: 'retryable-unavailable'; reason: string }
  | { status: 'terminal-unavailable'; reason: string };

interface BotAccountRow {
  id: string;
  owner_type: 'streamer' | 'system';
  twitch_user_id: string;
  twitch_username: string | null;
  twitch_display_name: string | null;
  twitch_access_token: string;
  twitch_refresh_token: string;
  twitch_token_expires_at: string;
}



/** PostgreSQL が返す 42703 (undefined_column) / 42P01 (undefined_table) を判定する。 */
function isMissingBotSchemaErrorPg(error: unknown): boolean {
  return isPgMissingColumnError(error) || isPgMissingTableError(error);
}

/**
 * getBotAccountForChat のPlanetScale実装。
 *
 * 読み取り（streamers / streamer_chat_sender_settings / twitch_bot_accounts）と
 * 書き込み（リフレッシュ後のトークン保存・エラーステータス保存）を同じ
 * PlanetScale接続へ固定し、認証情報が別DBへ分断されないようにする。
 *
 * - 各 .maybeSingle() は一意条件（streamers.twitch_user_id UNIQUE /
 *   streamer_chat_sender_settings.streamer_id PK / twitch_bot_accounts.id PK）
 *   で取得するため LIMIT 1 + rows[0] ?? null とする。official_bot は
 *   created_at昇順の先頭を正本として選ぶ。
 * - BOTスキーマ未配備はSQLSTATE 42703/42P01で検知し、安全側へ縮退する。
 * - トークン値はログに出さない。
 */
async function resolveBotAccountForChatPg(
  broadcasterTwitchUserId: string,
): Promise<BotChatAccountResolution> {
  let streamer: { id: string } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, broadcasterTwitchUserId))
          .limit(1);
      },
      'getBotAccountForChat(streamers)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    streamer = rows[0] ?? null;
  } catch (dbError) {
    logger.warn('Database error fetching BOT account', { broadcasterTwitchUserId, error: dbError });
    return {
      status: 'retryable-unavailable',
      reason: 'unable to resolve BOT sender from database',
    };
  }

  if (!streamer) {
    return { status: 'not-configured' };
  }
  // withDbRetry の queryFn（closure）から参照するため const に固定する
  const streamerId = streamer.id;

  let senderSettings: { sender_mode: string; custom_bot_account_id: string | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            sender_mode: streamerChatSenderSettingsTable.sender_mode,
            custom_bot_account_id: streamerChatSenderSettingsTable.custom_bot_account_id,
          })
          .from(streamerChatSenderSettingsTable)
          .where(eq(streamerChatSenderSettingsTable.streamer_id, streamerId))
          .limit(1);
      },
      'getBotAccountForChat(sender settings)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    senderSettings = rows[0] ?? null;
  } catch (settingsError) {
    if (isMissingBotSchemaErrorPg(settingsError)) {
      logger.warn('Chat sender settings schema is missing; disabling BOT chat sender', {
        broadcasterTwitchUserId,
        error: settingsError,
      });
      return {
        status: 'retryable-unavailable',
        reason: 'BOT sender schema is unavailable',
      };
    }
    logger.warn('Database error fetching chat sender settings', { broadcasterTwitchUserId, error: settingsError });
    return {
      status: 'retryable-unavailable',
      reason: 'unable to resolve BOT sender settings',
    };
  }

  if (!senderSettings || senderSettings.sender_mode === 'streamer') {
    return { status: 'not-configured' };
  }

  // 認証と送信に必要な8列だけを取得し、不要なcredential露出を避ける。
  const botAccountColumns = {
    id: twitchBotAccountsTable.id,
    owner_type: twitchBotAccountsTable.owner_type,
    twitch_user_id: twitchBotAccountsTable.twitch_user_id,
    twitch_username: twitchBotAccountsTable.twitch_username,
    twitch_display_name: twitchBotAccountsTable.twitch_display_name,
    twitch_access_token: twitchBotAccountsTable.twitch_access_token,
    twitch_refresh_token: twitchBotAccountsTable.twitch_refresh_token,
    twitch_token_expires_at: twitchBotAccountsTable.twitch_token_expires_at,
  };

  let botAccount: BotAccountRow | null = null;

  if (senderSettings.sender_mode === 'custom_bot') {
    if (!senderSettings.custom_bot_account_id) {
      return {
        status: 'terminal-unavailable',
        reason: 'configured custom BOT credential is missing',
      };
    }
    const customBotAccountId = senderSettings.custom_bot_account_id;

    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select(botAccountColumns)
            .from(twitchBotAccountsTable)
            .where(
              and(
                eq(twitchBotAccountsTable.id, customBotAccountId),
                eq(twitchBotAccountsTable.owner_type, 'streamer'),
                eq(twitchBotAccountsTable.streamer_id, streamerId),
                eq(twitchBotAccountsTable.status, 'active')
              )
            )
            .limit(1);
        },
        'getBotAccountForChat(custom bot)',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      );
      // owner_type は DB の CHECK 制約で 'streamer' | 'system' が保証されている。
      // 既存実装と同じ「型を合わせるだけのキャスト」（値の変換はしない）。
      botAccount = (rows[0] ?? null) as BotAccountRow | null;
    } catch (error) {
      if (isMissingBotSchemaErrorPg(error)) {
        logger.warn('Twitch BOT accounts schema is missing; disabling custom BOT sender', {
          broadcasterTwitchUserId,
          error,
        });
        return {
          status: 'retryable-unavailable',
          reason: 'BOT credential schema is unavailable',
        };
      }
      logger.warn('Database error fetching custom BOT account', { broadcasterTwitchUserId, error });
      return {
        status: 'retryable-unavailable',
        reason: 'unable to resolve custom BOT credential',
      };
    }
  } else if (senderSettings.sender_mode === 'official_bot') {
    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select(botAccountColumns)
            .from(twitchBotAccountsTable)
            .where(
              and(
                eq(twitchBotAccountsTable.owner_type, 'system'),
                eq(twitchBotAccountsTable.status, 'active')
              )
            )
            .orderBy(asc(twitchBotAccountsTable.created_at))
            .limit(1);
        },
        'getBotAccountForChat(official bot)',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      );
      botAccount = (rows[0] ?? null) as BotAccountRow | null;
    } catch (error) {
      if (isMissingBotSchemaErrorPg(error)) {
        logger.warn('Twitch BOT accounts schema is missing; disabling official BOT sender', {
          broadcasterTwitchUserId,
          error,
        });
        return {
          status: 'retryable-unavailable',
          reason: 'BOT credential schema is unavailable',
        };
      }
      logger.warn('Database error fetching official BOT account', { broadcasterTwitchUserId, error });
      return {
        status: 'retryable-unavailable',
        reason: 'unable to resolve official BOT credential',
      };
    }
  } else {
    // DB CHECK追加前の未知値や手動不整合は設定済みcredentialの恒久欠落として扱う。
    // 本人scope不足へ落とすと誤った再認証案内になるため、typed terminalを返す。
    return {
      status: 'terminal-unavailable',
      reason: 'configured BOT sender mode is unsupported',
    };
  }

  if (!botAccount) {
    return {
      status: 'terminal-unavailable',
      reason: 'configured BOT credential is unavailable',
    };
  }
  // withDbRetry の queryFn（closure）から参照するため const に固定する
  // （let のままだと TypeScript の null 除去ナローイングが closure 内へ届かない）
  const account = botAccount;

  const expiresAt = new Date(account.twitch_token_expires_at);
  if (isNaN(expiresAt.getTime())) {
    return {
      status: 'terminal-unavailable',
      reason: 'configured BOT credential expiry is invalid',
    };
  }

  if (expiresAt > new Date()) {
    return {
      status: 'available',
      account: {
        accountId: account.id,
        senderId: account.twitch_user_id,
        username: account.twitch_username,
        displayName: account.twitch_display_name,
        accessToken: account.twitch_access_token,
        ownerType: account.owner_type,
      },
    };
  }

  try {
    const accessToken = await runWithRefreshLease({
      acquire: leaseId => acquireBotRefreshLease(
        account.id,
        account.twitch_refresh_token,
        leaseId,
      ),
      release: leaseId => releaseBotRefreshLease(account.id, leaseId),
      readWinner: () => readBotRefreshWinner(account.id),
      refreshAndPersist: async leaseId => {
        let tokens: TwitchTokens
        try {
          tokens = await refreshTwitchToken(account.twitch_refresh_token)
        } catch (error) {
          // callbackが同値refresh tokenで新しい有効期限を保存する場合もある。
          // statusをerrorへ変える前にDB時刻で有効なwinnerを確認する。
          const callbackWinner = await readBotRefreshWinner(account.id)
          if (callbackWinner) return callbackWinner
          if (shouldDisableBotCredential(error)) {
            try {
              // permanent失効もlease ownerだけが確定できる。期限切れ旧leaderや
              // callback成功後の0件UPDATEは、新credential/statusを変更しない。
              await markBotRefreshLeaseFailed(
                account.id,
                account.twitch_refresh_token,
                leaseId,
              )
            } catch {
              // error状態の永続化失敗で元のOAuthエラーを置き換えない。leaseは
              // 未解除のままDB期限で回復し、次requestのstampedeを防ぐ。
            }
          }
          throw error
        }
        const renewed = await renewBotRefreshLeaseForSave(
          account.id,
          account.twitch_refresh_token,
          leaseId,
        )
        if (!renewed) {
          throw new Error('BOT token refresh lease expired before save')
        }
        const refreshedExpiresAt = new Date(Date.now() + tokens.expires_in * 1000)
        const updated = await withDbRetry(
          async () => {
            const { db } = await getDb()
            return db
              .update(twitchBotAccountsTable)
              .set({
                twitch_access_token: tokens.access_token,
                twitch_refresh_token: tokens.refresh_token,
                twitch_token_expires_at: refreshedExpiresAt.toISOString(),
                scopes: tokens.scope ?? [],
                status: 'active',
                last_error: null,
                twitch_refresh_lease_id: null,
                twitch_refresh_lease_expires_at: null,
              })
              .where(and(
                eq(twitchBotAccountsTable.id, account.id),
                eq(twitchBotAccountsTable.twitch_refresh_token, account.twitch_refresh_token),
                // lease期限後に新leaderが所有権を取った場合、旧leaderの遅い応答を
                // token CASだけでなくfencing IDでも拒否する。
                eq(twitchBotAccountsTable.twitch_refresh_lease_id, leaseId),
              ))
              .returning({ twitch_access_token: twitchBotAccountsTable.twitch_access_token })
          },
          'getBotAccountForChat(save refreshed token)',
          // token + lease IDのCASなので、応答消失後の再実行は0件となり、
          // runWithRefreshLeaseが保存済みwinnerを再読込できる。
          { idempotent: true },
        )
        if (updated.length === 0) {
          throw new Error('BOT token refresh lease was superseded before save')
        }
        return updated[0].twitch_access_token
      },
    })

    return {
      status: 'available',
      account: {
        accountId: account.id,
        senderId: account.twitch_user_id,
        username: account.twitch_username,
        displayName: account.twitch_display_name,
        accessToken,
        ownerType: account.owner_type,
      },
    };
  } catch (error) {
    // Twitch公式では無効refresh tokenを400/401として再同意対象にする。それ以外は
    // 上流・network・DB・lease競合など回復可能性を否定できないためbounded retryへ。
    const terminal = shouldDisableBotCredential(error);
    // この層はtyped結果を返す責務に限定する。logger.server.errorはerrors永続化を伴い、
    // legacy/live/replayの所有境界でも同じterminalを報告すると二重Issue候補になる。
    // retryable・terminalともここではwarn、呼び出し境界で最終状態と合わせて1回報告する。
    // Issue #653/#670系と同様、status/kindが無いとContextだけでは
    // terminal/retryableの根拠を後から確認できないため付与する
    // (twitchTokenRefreshFailureContext参照。terminal自体の判定は
    // shouldDisableBotCredential内で既にstatus/kindを見ているため変更しない)。
    const logContext = {
      broadcasterTwitchUserId,
      accountId: account.id,
      ...twitchTokenRefreshFailureContext(error),
    };
    if (terminal) {
      logger.warn('Failed to refresh BOT Twitch access token', logContext);
      return {
        status: 'terminal-unavailable',
        reason: 'configured BOT credential requires reauthorization',
      };
    }
    logger.warn('Failed to refresh BOT Twitch access token', logContext);
    return {
      status: 'retryable-unavailable',
      reason: 'configured BOT credential is temporarily unavailable',
    };
  }
}

/** chat outbox向けの判別可能なBOT sender解決契約。 */
export async function resolveBotAccountForChat(
  broadcasterTwitchUserId: string,
): Promise<BotChatAccountResolution> {
  return resolveBotAccountForChatPg(broadcasterTwitchUserId);
}

/**
 * 既存呼び出し向けのnullable互換wrapper。新しい送信経路は障害分類を失わないよう
 * resolveBotAccountForChat()を使用する。
 */
export async function getBotAccountForChat(broadcasterTwitchUserId: string): Promise<BotChatAccount | null> {
  const resolution = await resolveBotAccountForChatPg(broadcasterTwitchUserId);
  return resolution.status === 'available' ? resolution.account : null;
}

/**
 * getCustomBotAccountDisplayForStreamer のPlanetScale実装。
 *
 * 表示補助はDB障害時に認証処理を止めない契約のため、各クエリをcatchしてnullへ落とす。
 */
async function getCustomBotAccountDisplayForStreamerPg(
  streamerId: string
): Promise<{ username: string | null; displayName: string | null } | null> {
  let settings: { sender_mode: string; custom_bot_account_id: string | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            sender_mode: streamerChatSenderSettingsTable.sender_mode,
            custom_bot_account_id: streamerChatSenderSettingsTable.custom_bot_account_id,
          })
          .from(streamerChatSenderSettingsTable)
          .where(eq(streamerChatSenderSettingsTable.streamer_id, streamerId))
          .limit(1); // streamer_id は PK（migration 00040）のため maybeSingle と同じ外部挙動
      },
      'getCustomBotAccountDisplayForStreamer(settings)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    settings = rows[0] ?? null;
  } catch {
    // 表示補助の失敗は呼び出し元の設定画面を止めず、未設定表示へ縮退する。
    return null;
  }

  if (settings?.sender_mode !== 'custom_bot' || !settings.custom_bot_account_id) {
    return null;
  }
  const customBotAccountId = settings.custom_bot_account_id;

  let botAccount: { twitch_username: string | null; twitch_display_name: string | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            twitch_username: twitchBotAccountsTable.twitch_username,
            twitch_display_name: twitchBotAccountsTable.twitch_display_name,
          })
          .from(twitchBotAccountsTable)
          .where(
            and(
              eq(twitchBotAccountsTable.id, customBotAccountId),
              eq(twitchBotAccountsTable.owner_type, 'streamer'),
              eq(twitchBotAccountsTable.streamer_id, streamerId),
              eq(twitchBotAccountsTable.status, 'active')
            )
          )
          .limit(1); // id は PK のため maybeSingle と同じ外部挙動
      },
      'getCustomBotAccountDisplayForStreamer(bot account)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    botAccount = rows[0] ?? null;
  } catch {
    // BOT表示名を取得できない場合は未設定表示へ縮退する。
    return null;
  }

  if (!botAccount) {
    return null;
  }

  return {
    username: botAccount.twitch_username,
    displayName: botAccount.twitch_display_name,
  };
}

export async function getCustomBotAccountDisplayForStreamer(
  streamerId: string
): Promise<{ username: string | null; displayName: string | null } | null> {
  return getCustomBotAccountDisplayForStreamerPg(streamerId);
}

/**
 * refreshTwitchAccessToken の pg 直結実装 (#572)
 *
 * tokenとscopeは同じCAS UPDATEへ統合し、OAuth callbackが
 * 並行して保存した新しいtoken/scopeを旧refresh結果の後続UPDATEで上書きしない。
 * トークン列未配備のデプロイ窓は SQLSTATE 42703 を
 * isPgMissingColumnError で判定する（トークン値はログに出さない）。
 */
async function refreshTwitchAccessTokenPg(twitchUserId: string, refreshToken: string): Promise<string> {
  try {
    return await runWithRefreshLease({
      acquire: leaseId => acquireUserRefreshLease(
        twitchUserId,
        refreshToken,
        leaseId,
      ),
      release: leaseId => releaseUserRefreshLease(twitchUserId, leaseId),
      readWinner: () => readUserRefreshWinner(twitchUserId),
      refreshAndPersist: async leaseId => {
        const tokens = await refreshTwitchToken(refreshToken)
        const renewed = await renewUserRefreshLeaseForSave(
          twitchUserId,
          refreshToken,
          leaseId,
        )
        if (!renewed) {
          throw new Error('Twitch token refresh lease expired before save')
        }
        const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
        const updated = await withDbRetry(
          async () => {
            const { db } = await getDb()
            return db
              .update(usersTable)
              .set({
                twitch_access_token: tokens.access_token,
                twitch_refresh_token: tokens.refresh_token,
                twitch_token_expires_at: expiresAt.toISOString(),
                twitch_scopes: tokens.scope ?? [],
                twitch_refresh_lease_id: null,
                twitch_refresh_lease_expires_at: null,
              })
              .where(and(
                eq(usersTable.twitch_user_id, twitchUserId),
                eq(usersTable.twitch_refresh_token, refreshToken),
                eq(usersTable.twitch_refresh_lease_id, leaseId),
              ))
              .returning({ twitch_access_token: usersTable.twitch_access_token })
          },
          'refreshTwitchAccessToken(save)',
          { idempotent: true },
        )
        const persistedAccessToken = updated[0]?.twitch_access_token
        if (!persistedAccessToken) {
          throw new Error('Twitch token refresh lease was superseded before save')
        }
        return persistedAccessToken
      },
    })
  } catch (error) {
    // lease列未配備は呼び出し元がTwitchTokenError(DATABASE_ERROR)へ変換し、
    // chat outboxをterminalにせずbounded retryへ戻すため、SQLSTATEを隠さず返す。
    if (isPgMissingColumnError(error)) throw error
    // 永続化責任は bootstrap/rewards/callback 等の API 境界に統一する。ここで
    // logger.error を使うと同じ例外を下位層と境界の双方が errors へ書く。
    // Issue #653/#670: refreshStatus/refreshErrorKindをcontextへ含めることで、
    // auto-generated bug reportのContextが空のまま「恒久エラーか一時エラーか
    // 判別できない」という状態を解消する(twitchTokenRefreshFailureContext参照)。
    // originalErrorも保持し、上位で必要になった際に握りつぶさず参照できるようにする。
    logger.warn('Failed to refresh Twitch access token', {
      twitchUserId,
      ...twitchTokenRefreshFailureContext(error),
    });
    throw new TwitchTokenError(
      'Failed to refresh Twitch access token',
      'REFRESH_FAILED',
      error instanceof Error ? error : undefined,
    );
  }
}

async function refreshTwitchAccessToken(twitchUserId: string, refreshToken: string): Promise<string> {
  return refreshTwitchAccessTokenPg(twitchUserId, refreshToken);
}

/**
 * saveTwitchTokens のPlanetScale実装。
 * 列未配備のデプロイ窓は 42703 (isPgMissingColumnError) で判定する。
 */
async function saveTwitchTokensPg(twitchUserId: string, tokens: TwitchTokens): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .update(usersTable)
          .set({
            twitch_access_token: tokens.access_token,
            twitch_refresh_token: tokens.refresh_token,
            twitch_token_expires_at: expiresAt.toISOString(),
            // login/callback等からの権威保存は、同値refresh tokenでも進行中leaseを
            // 無効化し、旧leaderのfencing saveを0件にする。
            twitch_refresh_lease_id: null,
            twitch_refresh_lease_expires_at: null,
          })
          .where(eq(usersTable.twitch_user_id, twitchUserId));
      },
      'saveTwitchTokens',
      // リトライしても同じトークン値を書く UPDATE のため冪等（リトライ可）。
      // リトライ待機中に並行リフレッシュの新しいトークンを古い値で上書きする
      // 競合窓を広げる側面とその許容判断（リトライ禁止による確実なトークン喪失の
      // ほうが害が大きい）は refreshTwitchAccessTokenPg の同箇所コメントを参照。
      { idempotent: true },
    );
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      // token保存に安全な代替先はない。成功として返すとログイン完了後にtokenが
      // 消失するため、schema欠落を明示して呼び出し元の認証処理をfail-closedにする。
      logger.error('Twitch token columns are missing; token save failed closed', {
        twitchUserId,
        error,
      });
    }
    throw error;
  }
}

export async function saveTwitchTokens(twitchUserId: string, tokens: TwitchTokens): Promise<void> {
  return saveTwitchTokensPg(twitchUserId, tokens);
}

/**
 * deleteTwitchTokens のPlanetScale実装。
 */
async function deleteTwitchTokensPg(twitchUserId: string): Promise<void> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .update(usersTable)
          .set({
            twitch_access_token: null,
            twitch_refresh_token: null,
            twitch_token_expires_at: null,
            // logoutはcredentialだけでなく進行中refreshの書込権も失効させる。
            twitch_refresh_lease_id: null,
            twitch_refresh_lease_expires_at: null,
          })
          .where(eq(usersTable.twitch_user_id, twitchUserId));
      },
      'deleteTwitchTokens',
      // 常に同じ値（NULL）を書く UPDATE のためリトライしても冪等。
      // リトライ待機中の並行リフレッシュとの競合窓（この関数の場合は、待機中に
      // 書き込まれた新トークンを NULL で上書きする＝ログアウト意図どおりの結果に
      // なる側面が強い）とリトライ許容の判断根拠は refreshTwitchAccessTokenPg の
      // 同箇所コメントを参照。
      { idempotent: true },
    );
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      // logout時の削除を成功扱いすると有効なcredentialがDBに残る。セキュリティ
      // 境界なので、schema不整合は必ず呼び出し元へ伝播させる。
      logger.error('Twitch token columns are missing; token deletion failed closed', {
        twitchUserId,
        error,
      });
    }
    throw error;
  }
}

export async function deleteTwitchTokens(twitchUserId: string): Promise<void> {
  return deleteTwitchTokensPg(twitchUserId);
}

/**
 * 保存スコープの厳格な判定結果。unavailableはDB/スキーマ障害により
 * grantedかmissingかを確定できない状態であり、missingとして扱ってはならない。
 */
export type TwitchScopeStatus = 'granted' | 'missing' | 'unavailable';

/**
 * scope三値判定のPlanetScale/Drizzle実装。
 * twitch_scopesはtext[]列のためDrizzleスキーマ経由で読み、DB障害は
 * unavailableとしてscope不足と分離する。
 */
async function getScopeStatusPg(
  twitchUserId: string,
  scope: string,
  reportUnavailable: boolean,
): Promise<TwitchScopeStatus> {
  let user: { twitch_scopes: string[] | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ twitch_scopes: usersTable.twitch_scopes })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1); // twitch_user_id は UNIQUE（00001）のため maybeSingle と同じ外部挙動
      },
      'Twitch scope check',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    user = rows[0] ?? null;
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      const context = {
        twitchUserId,
        scope,
        error,
      };
      // boolean hasScope()の既存callerはunavailableをfalseへ畳み、上位に報告境界を
      // 持たないため従来どおりerrorを残す。chatの三値callerはbounded retry/DLQの
      // 上位境界で1回だけ報告するので、ここではwarnに留めて二重Issue化を防ぐ。
      if (reportUnavailable) {
        logger.error('twitch_scopes column is missing; denying scope access', context);
      } else {
        logger.warn('twitch_scopes column is missing; denying scope access', context);
      }
      return 'unavailable';
    }
    const context = { twitchUserId, scope, error };
    if (reportUnavailable) {
      logger.error('Database error checking scope', context);
    } else {
      logger.warn('Database error checking scope', context);
    }
    return 'unavailable';
  }

  // twitch_scopesがnullまたは空配列の場合、追加スコープは付与されていない
  // If twitch_scopes is null or empty, no additional scopes have been granted
  if (!user?.twitch_scopes || user.twitch_scopes.length === 0) {
    return 'missing';
  }

  return user.twitch_scopes.includes(scope) ? 'granted' : 'missing';
}

async function hasScopePg(twitchUserId: string, scope: string): Promise<boolean> {
  // booleanへ情報を失う前に、DB判定不能をこの境界で永続化する。
  return (await getScopeStatusPg(twitchUserId, scope, true)) === 'granted';
}

/**
 * ユーザーが特定のTwitchスコープを持つかをbooleanで返す既存契約。
 * 認可UIをfail-closedに保つため、missingとunavailableはいずれもfalseを返す。
 */
export async function hasScope(twitchUserId: string, scope: string): Promise<boolean> {
  return hasScopePg(twitchUserId, scope);
}

/**
 * scope不足とDB判定不能を分離する厳格な三値契約。
 * chat outboxはmissingだけを恒久DLQ化し、unavailableをbounded retryへ回すことで、
 * 一時的なDB障害による通知の永久欠落を防ぐ。
 */
export async function getScopeStatus(
  twitchUserId: string,
  scope: string,
): Promise<TwitchScopeStatus> {
  // chat callerはtyped unavailableを受け取り、live/dead到達時に上位で報告する。
  return getScopeStatusPg(twitchUserId, scope, false);
}

/**
 * ユーザーのTwitchスコープから特定のスコープを削除する
 * トークンが実際にはスコープを持っていないことが判明した場合（401エラー等）に使用
 * Remove a specific scope from a user's Twitch scopes in the database.
 * Used when it's discovered the token doesn't actually have the scope (e.g., 401 error)
 * @param twitchUserId - TwitchユーザーID
 * @param scope - 削除するスコープ（例: 'user:write:chat'）
 */
/**
 * removeScope のPlanetScale実装。
 * 読み取り（現在のスコープ取得）と書き込み（除外後の全置換 UPDATE）が混在する
 * ため、両方を同じDB接続へ固定する。一般DB障害は権限表示を安全側へ倒すため
 * 静かにreturnし、schema欠落だけはデプロイ不整合として伝播する。
 */
async function removeScopePg(twitchUserId: string, scope: string): Promise<void> {
  let user: { twitch_scopes: string[] | null } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ twitch_scopes: usersTable.twitch_scopes })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      'removeScope(fetch)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );
    user = rows[0] ?? null;
  } catch (fetchError) {
    if (isPgMissingColumnError(fetchError)) {
      // 無効と判明したscopeを削除できない状態を成功扱いしない。呼び出し元へ
      // 伝播させ、権限状態の乖離を監視・再試行できるようにする。
      logger.error('twitch_scopes column is missing; scope removal failed closed', {
        twitchUserId,
        scope,
        error: fetchError,
      });
      throw fetchError;
    }
    logger.error('Failed to fetch scopes for removal', { twitchUserId, scope, error: fetchError });
    return;
  }

  if (!user?.twitch_scopes || !user.twitch_scopes.includes(scope)) {
    return;
  }

  // 指定スコープを除外した配列で更新
  // Update with the scope filtered out
  const updatedScopes = user.twitch_scopes.filter((s: string) => s !== scope);

  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .update(usersTable)
          .set({ twitch_scopes: updatedScopes })
          .where(eq(usersTable.twitch_user_id, twitchUserId));
      },
      'removeScope(update)',
      // 事前計算した同じ配列を書く全置換 UPDATE のためリトライしても冪等
      { idempotent: true },
    );
  } catch (updateError) {
    if (isPgMissingColumnError(updateError)) {
      logger.error('twitch_scopes column is missing; scope removal update failed closed', {
        twitchUserId,
        scope,
        error: updateError,
      });
      throw updateError;
    }
    logger.error('Failed to remove scope', { twitchUserId, scope, error: updateError });
    return;
  }

  logger.info('Removed invalid scope from user', {
    twitchUserId,
    removedScope: scope,
    remainingScopes: updatedScopes,
  });
}

export async function removeScope(twitchUserId: string, scope: string): Promise<void> {
  return removeScopePg(twitchUserId, scope);
}

/**
 * ユーザーのTwitchスコープをデータベースに保存（全置換）
 * 通常ログイン・再認証フロー双方から呼ばれる。
 * トークンの実スコープでDBを全置換することでDB/トークン乖離を防ぐ。
 * Save Twitch scopes to database for a user (full replace).
 * Called from both regular login and re-auth flows.
 * Full replace keeps DB in sync with actual token scopes, preventing divergence.
 * @param twitchUserId - TwitchユーザーID
 * @param scopes - 保存するスコープの配列
 */
/**
 * saveTwitchScopes のPlanetScale実装。
 */
async function saveTwitchScopesPg(twitchUserId: string, scopes: string[]): Promise<void> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .update(usersTable)
          .set({
            twitch_scopes: scopes,
          })
          .where(eq(usersTable.twitch_user_id, twitchUserId));
      },
      'saveTwitchScopes',
      // 同じ配列を書く全置換 UPDATE のためリトライしても冪等
      { idempotent: true },
    );
  } catch (error) {
    if (isPgMissingColumnError(error)) {
      // 実tokenのscopeとの全置換に失敗したまま成功を返すと、DB上の権限表示が
      // 恒久的に誤る。schema欠落はlogger.errorへ残して呼び出し元へ伝播する。
      logger.error('twitch_scopes column is missing; scope save failed closed', {
        twitchUserId,
        error,
      });
    }
    logger.error('Failed to save Twitch scopes', { twitchUserId, scopes, error });
    throw error;
  }

  logger.info('Saved Twitch scopes for user', { twitchUserId, scopeCount: scopes.length });
}

export async function saveTwitchScopes(twitchUserId: string, scopes: string[]): Promise<void> {
  return saveTwitchScopesPg(twitchUserId, scopes);
}

/**
 * Twitch /oauth2/validate でトークンの実スコープを取得する
 * check-scope APIからの参照用（DB更新は行わない、read-only）
 * Fetch actual token scopes from Twitch /oauth2/validate endpoint.
 * Read-only: used by check-scope API to detect DB/token divergence without modifying DB.
 * @param twitchUserId - TwitchユーザーID
 * @returns スコープ配列、トークン無効時は空配列、判定不能時はnull
 */
/**
 * validateTokenScopes のPlanetScale実装。
 *
 * DBアクセスは読み取りのみで、リフレッシュも書き込みも行わない。
 * ローカル期限を確認してからTwitch /oauth2/validateを呼び、不要な外部I/Oを避ける。
 */
async function validateTokenScopesPg(twitchUserId: string): Promise<string[] | null> {
  try {
    let user: { twitch_access_token: string | null; twitch_token_expires_at: string | null } | null;
    try {
      const rows = await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { db } = await getDb();
          return db
            .select({
              twitch_access_token: usersTable.twitch_access_token,
              twitch_token_expires_at: usersTable.twitch_token_expires_at,
            })
            .from(usersTable)
            .where(eq(usersTable.twitch_user_id, twitchUserId))
            .limit(1);
        },
        'twitch token scope validation fetch',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      );
      user = rows[0] ?? null;
    } catch {
      // 既存経路は dbError 時に（ログなしで）null を返し、呼び出し元に DB 信頼を委ねる
      return null;
    }

    if (!user?.twitch_access_token) return null;

    // ローカルで期限切れならTwitch APIを叩かず、判定不能としてnullを返す。
    if (user.twitch_token_expires_at) {
      const expiresAt = new Date(user.twitch_token_expires_at);
      if (!isNaN(expiresAt.getTime()) && expiresAt <= new Date()) {
        return null;
      }
    }

    const response = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${user.twitch_access_token}` },
    });

    // 401/403（期限内トークンに対して）= revoke 等の無効化 → 空配列で乖離検出
    if (response.status === 401 || response.status === 403) {
      return [];
    }
    // ネットワークエラー/5xx = 判定不能 → null で呼び出し元に DB 信頼を委ねる
    if (!response.ok) return null;

    const data = await response.json();
    return data.scopes ?? [];
  } catch (error) {
    // DB エラー/ネットワーク例外時 → null で呼び出し元に DB 信頼を委ねる
    logger.warn('Failed to validate token scopes', {
      twitchUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function validateTokenScopes(twitchUserId: string): Promise<string[] | null> {
  return validateTokenScopesPg(twitchUserId);
}
