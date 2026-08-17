import { type NextRequest, NextResponse } from "next/server";
import { ERROR_MESSAGES } from "@/lib/constants";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { logger } from "@/lib/logger.server";
import { constantTimeEqual } from "@/lib/crypto-utils";
import { reportError } from "@/lib/sentry/error-handler";
import { getKvBinding, type KVNamespaceLike } from "@/lib/cloudflare-kv";
import {
  listAllEventSubSubscriptions,
  isUnhealthyEventSubStatus,
} from "@/lib/twitch/eventsub-subscriptions";

/**
 * EventSub サブスクリプション健全性監視エンドポイント (Issue #540)。
 *
 * 背景: 本番障害 #527 で、EventSub サブスクリプションが `disabled` 相当の
 * 状態に落ちても、検知手段が「Twitch Developer Console を手動確認する」という
 * 運用依存の手順しかなかった。Twitch はコールバック検証やnotification送信に
 * 連続失敗すると自動でサブスクリプションを終端状態へ落とすため、再デプロイ後も
 * 気づかれないまま全視聴者のガチャ交換が無音で失敗し続けるリスクがある。
 *
 * 本routeは `workers/error-reporter`（既存の5分毎Cron Worker）から
 * prod/preview 双方へ定期的に呼ばれる想定の運用エンドポイント（詳細は
 * `workers/error-reporter/src/index.ts` の processEventSubSubscriptionHealth
 * 参照）。ただし呼び出し元を問わず、このroute自身が呼ばれる度に判定・
 * アラートを完結させる設計にしている（cron worker側は「定期的に叩くトリガー」
 * の役割のみで、健全性判定・アラート発行のロジックは複製しない）。
 *
 * 認証: db-health/route.ts / eventsub-replay/route.ts と同じ共有シークレット
 * パターン（新規シークレット EVENTSUB_HEALTH_SECRET・ヘッダー
 * X-EventSub-Health-Secret・定数時間比較・未設定なら500 fail-closed・
 * 不一致なら403）。
 *
 * アラート方式: issue本文は「Sentry / logger.error 経由」を要求しているが、
 * このリポジトリは #235 で Sentry SDK を削除済みで、reportError() が
 * console出力 + `errors` テーブルへの永続化を担う後継実装になっている
 * (src/lib/sentry/error-handler.ts 冒頭コメント参照)。`errors` テーブルに
 * 積まれた行は既存の `twica-error-reporter` Cron Worker が5分毎に読み出し、
 * 同一シグネチャ（今回は environment ごとに固定したメッセージ文字列。
 * buildUnhealthyAlertMessage / buildFetchFailedAlertMessage 参照）で
 * グルーピングしながら GitHub Issue を自動作成・再発時はコメント追記する。
 * そのため本routeは
 * 独自にGitHub Issueを作らず、`reportError` を呼ぶだけで既存のアラート
 * パイプラインにそのまま乗る。`logger.error`（fire-and-forget実装）ではなく
 * `reportError` を直接 await する理由: logger.server.ts 冒頭コメントの指示
 * どおり「記録完了をレスポンス前に保証する必要がある経路」に該当するため
 * （cron呼び出しがタイムアウトで打ち切られても、それより前にDB書き込みを
 * 完了させておきたい）。
 *
 * スコープ外（YAGNI、#540 実装プランどおり）: 自動再登録（disabled
 * サブスクリプションの自動削除・再作成）は挙動リスクが高いため、本routeでは
 * 検知・アラートのみ行い、実装しない。再登録手順は
 * docs/eventsub-subscription-health.md を参照。
 *
 * アラート頻度制御（PR #1009 レビュー指摘・必須）: 本routeは5分毎に呼ばれる
 * ため、対策が反映されるまで unhealthy が続く限り、対策なしでは
 * `reportError` を毎tick呼び続けてしまう。error-reporter の
 * `processErrors` は同一signatureのOpen Issueへ**クールダウン無しで**
 * コメント追記するため、これは同じファイル内の processEventSubParkBacklog
 * が明示的に否定した「5分に1回コメントが増え続けるスパム」に該当する
 * （processEventSubParkBacklog はこれを避けるため reportError を経由せず
 * Worker側で直接 GitHub Issues API を叩き、Open Issueがあればスキップする
 * 設計を選んでいる）。
 * 本routeでも同じ「Open Issueがあればスキップ」方式へ寄せることは可能だが、
 * それには GitHub Issues API 呼び出しロジックをWorker側からroute側へ複製する
 * (または逆にWorker側へアラート判定ロジックを複製し戻す)必要があり、
 * 「判定・アラートをroute側へ集約しWorkerをトリガーに徹させる」という
 * 本機能の分離設計（このJSDoc冒頭参照）を崩してしまう。
 * 代わりに、KV（RATE_LIMIT_KVを他の用途と同じくdisjointなキーprefixで共用。
 * root wrangler.tomlのコメント参照）へ「直近でアラート済みの問題の
 * fingerprint（何が起きているかを表す文字列）とその時刻」を保存し、
 *   (a) 前回と同じfingerprintのままクールダウン期間内 → 再アラートをスキップ
 *   (b) fingerprintが変化した(新たに壊れた/一部回復した) → クールダウン中でも
 *       即座に再アラート(悪化・変化を見逃さない)
 *   (c) クールダウン期間を過ぎた → 同じfingerprintでも再アラート
 *       (「まだ直っていない」ことを示す生存確認、無音で放置されるのを防ぐ)
 * という3条件のいずれかで通知(reportError/logger.error)を呼ぶ。KV読み書きに
 * 失敗した場合は fail-open（判定不能として常にアラートする）にする —
 * 監視機能が「サイレントに沈黙する」方向の失敗より「多少うるさい」方向の
 * 失敗の方が安全なため（src/lib/twitch/app-token.ts の
 * getTwitchAppAccessToken と同じ思想）。
 *
 * このゲートは3つの独立した通知経路すべてに適用する（PR #1009 3回目の
 * レビュー指摘・必須。当初はunhealthy検知側にしか適用しておらず、fetch失敗
 * ・secret未設定の2経路が同じスパムパターンを起こしたまま残っていた）:
 *   1. unhealthy検知（fingerprint = ソート済みsubscription id集合）
 *   2. Twitch API/app token呼び出し失敗（fingerprint = 固定文字列。エラー
 *      詳細ごとに区別すると status code 違いだけでシグネチャが割れ、
 *      buildFetchFailedAlertMessage が防ごうとしている可変メッセージ問題を
 *      文字列は直っても実質的に再現してしまうため、あえて区別しない）
 *   3. EVENTSUB_HEALTH_SECRET 未設定（fingerprint = 固定文字列。Workerの
 *      secretだけ先に設定されアプリ側が未設定という一時的なデプロイ順序の
 *      過渡期で5分毎に発生しうる）
 */

/**
 * アラートの重複作成防止用に固定するメッセージを組み立てる。
 * error-reporter Cron Worker はエラーを
 * `error_type + message先頭行 + stack先頭行` のシグネチャでグルーピングする
 * (workers/error-reporter/src/index.ts の generateSignature 参照)。
 * count や subscription id 等の可変値をメッセージ本文に含めると、値が変わる
 * 度に別シグネチャ扱いとなり、同じ障害で毎回新規 Issue が乱立してしまう。
 * 可変情報は必ず reportError の第2引数(context)側に渡すこと。
 *
 * environment を引数に取る理由（PR #1009 レビュー指摘）: `errors.environment`
 * 列自体は persistErrorToDatabase が別途算出するが、signature 自体には
 * environment が含まれない（generateSignature参照）。メッセージを完全な
 * 固定文字列にすると、prod/preview 両方の検知が同一 signature に潰れて
 * 1つの GitHub Issue へ混在してしまい、Issue のタイトル・ラベルは
 * 「たまたま先に検知された側」の environment で固定される
 * （createErrorIssue が `errs[0]`＝時系列で最初の行の environment を使うため）。
 * 以後もう片方の environment のアラートはその Issue へのコメントとして届くが、
 * addCommentToIssue のコメント本文は count/lastSeen のみで environment を
 * 含まないため、どちらの環境の障害か本文から判別できなくなる。
 * environment ごとに固定文字列を分ける（値域は production/preview の2つのみ
 * なので Issue 乱立は起きない）ことで、この混在を避けつつ、各環境内での
 * 「同じ検知の再送はコメント追記に畳む」性質は維持する。
 *
 * 既知の限定事項（本PRのスコープ外、フォローアップissue参照）: 同一
 * environment 内であっても、一度 Issue が close された後に再発すると
 * error-reporter の findExistingErrorIssue が state を絞らず検索するため、
 * 再度 close 済み Issue へコメントが追記されるだけで再オープンされない
 * （既存の errors→GitHub Issueパイプライン全体の仕様であり、本機能固有の
 * 問題ではない）。
 *
 * 注意: context は `errors.context` 列に残るだけでなく、
 * workers/error-reporter/src/index.ts の createErrorIssue が
 * `JSON.stringify(first.context, null, 2).slice(0, 2000)` として Issue 本文の
 * 「### Context」節にも出力する（Issue本文に出ない、という誤解をしないこと）。
 * ここへ渡す値は sanitizeContext（src/lib/log-sanitizer.ts）で機密キーが
 * `[REDACTED]` 化された後にDB永続化されるため、渡す前提でセンシティブな値を
 * 混ぜない（isSensitiveKeyの許可リストに乗らない独自のトークン等を追加する
 * 場合は特に注意）。
 */
function buildUnhealthyAlertMessage(environment: "production" | "preview"): string {
  return `[EventSub Health][${environment}] Unhealthy EventSub subscription(s) detected`;
}

/**
 * Twitch API/app token 呼び出し自体が失敗した場合のアラートメッセージ。
 * buildUnhealthyAlertMessage と同じ理由でenvironmentごとに固定する。
 * 実際のエラー内容（status code・message等、fetch失敗の詳細で可変）は
 * context側にのみ渡し、message自体には含めない（PR #1009 3回目のレビュー
 * 指摘・必須: 当初は err をそのまま渡していたため、status code違いだけで
 * signatureが割れ、環境が混在するだけでなくIssueも乱立していた）。
 */
function buildFetchFailedAlertMessage(environment: "production" | "preview"): string {
  return `[EventSub Health][${environment}] Failed to check EventSub subscription health`;
}

/** `process.env.NEXT_PUBLIC_APP_URL` から environment を判定する。
 * `src/lib/sentry/error-handler.ts` の persistErrorToDatabase と同じロジック
 * （errors.environment 列の算出方法と一致させておく必要があるため、意図的な
 * 重複実装。フォローアップissueで共通化を検討）。 */
function resolveEnvironment(): "production" | "preview" {
  return (process.env.NEXT_PUBLIC_APP_URL || "").includes("preview") ? "preview" : "production";
}

/** KV上のアラート状態キーのprefix。root wrangler.tomlのRATE_LIMIT_KVコメント
 * が列挙する既存用途（レート制限・maintenance EventSub parking・OBSデモ
 * イベント・Twitch app tokenキャッシュ）と衝突しないdisjointな新規prefix。 */
const EVENTSUB_HEALTH_ALERT_KV_PREFIX = "eventsub-health:alert-state:";

/** 同じunhealthy集合が続く間、再アラートを間引くクールダウン期間。
 * 短すぎると本findingが指摘したスパムが再発し、長すぎると「まだ直っていない」
 * ことに運用者が気づく頻度が下がる。1時間毎の生存確認+即時エスカレーション
 * (集合変化時は無条件即時アラート)の組み合わせで、5分毎の12件/時から
 * 1件/時へ抑えつつ沈黙はさせない。 */
const EVENTSUB_HEALTH_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/** KVエントリのTTL。クールダウンより長く取り、問題が解消してから
 * 十分な時間が経てば状態キー自体が自然消滅するようにする(手動delete不要)。 */
const EVENTSUB_HEALTH_ALERT_KV_TTL_SECONDS = (EVENTSUB_HEALTH_ALERT_COOLDOWN_MS / 1000) * 2;

interface EventSubHealthAlertState {
  /** 直近のアラート時点での「問題の形」を表す文字列（等価比較にのみ使う）。 */
  fingerprint: string;
  /** 直近にアラートした時刻（epoch ms）。 */
  alertedAt: number;
}

/** unhealthy検知の fingerprint（ソート済みsubscription id集合をjoin）を作る。 */
function unhealthyFingerprint(subscriptionIds: string[]): string {
  return [...subscriptionIds].sort().join(",");
}

/**
 * 今回のfingerprintについてアラート(reportError/logger.error)すべきかを
 * 判定する。KVの読み取りに失敗した場合はfail-open（true）で返す —
 * 判定不能を理由に監視が沈黙する方が、多少アラートが増えるより悪い
 * （このファイル冒頭のJSDoc「アラート頻度制御」節参照）。
 *
 * @param kvKey 通知経路ごとに独立したクールダウンを持たせるためのKVキー
 *   （unhealthy検知・fetch失敗・secret未設定の3経路はそれぞれ別キーを使う。
 *   同じキーを共有すると、例えばfetch失敗中にunhealthy検知の再アラートまで
 *   巻き込んで抑制してしまう）。
 * @param fingerprint 今回の「問題の形」を表す文字列。前回と異なればクール
 *   ダウン中でも即座にtrueを返す。
 */
async function shouldSendAlert(
  kv: KVNamespaceLike | null,
  kvKey: string,
  fingerprint: string,
  now: number
): Promise<boolean> {
  if (!kv) return true; // ローカル開発等でKV bindingが無い場合はfail-open。

  try {
    const raw = await kv.get(kvKey);
    if (!raw) return true; // 前回状態が無い(初回検知 or TTL失効) → アラートする。

    const cached = JSON.parse(raw) as EventSubHealthAlertState;
    if (cached.fingerprint !== fingerprint) return true; // 状態が変化 → 即座にアラート。

    const cooldownExpired =
      typeof cached.alertedAt !== "number" ||
      now - cached.alertedAt >= EVENTSUB_HEALTH_ALERT_COOLDOWN_MS;
    return cooldownExpired; // 同じ状態でもクールダウンを過ぎていれば生存確認として再アラート。
  } catch (err) {
    logger.warn("[eventsub-health] Failed to read alert cooldown state from KV, defaulting to alert", {
      kvKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * アラート送信後に、今回のfingerprintと時刻をKVへ記録する。
 * 書き込み失敗は呼び出し元の通知自体の成否に影響させない(ベストエフォート) —
 * 次回tickでKVが復旧すれば追従する。書き込み失敗時に次回もアラートが
 * 飛ぶ(＝多少うるさくなる)のは、上記shouldSendAlertと同じfail-open方針と
 * 整合する安全側の失敗モード。
 */
async function recordAlertState(
  kv: KVNamespaceLike | null,
  kvKey: string,
  fingerprint: string,
  now: number
): Promise<void> {
  if (!kv) return;
  const state: EventSubHealthAlertState = { fingerprint, alertedAt: now };
  try {
    await kv.put(kvKey, JSON.stringify(state), {
      expirationTtl: EVENTSUB_HEALTH_ALERT_KV_TTL_SECONDS,
    });
  } catch (err) {
    logger.warn("[eventsub-health] Failed to persist alert cooldown state to KV", {
      kvKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * unhealthy検知が解消した(0件になった)場合にクールダウン状態を消す。
 * PR #1009 レビュー指摘(任意、フォローアップissue #1010から本PRへ前倒し):
 * これを呼ばないと「壊れて通知→復旧→再び壊れる」というflapping時に、KVへ
 * 残った前回のfingerprintと偶然一致してクールダウンに握り潰されうる
 * （例: 同じsubscription集合が一時的に復旧してから再発した場合）。
 * 削除失敗はベストエフォート（次回のexpirationTtlで自然消滅するため実害は
 * 軽微）。
 */
async function clearAlertState(kv: KVNamespaceLike | null, kvKey: string): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete(kvKey);
  } catch (err) {
    logger.warn("[eventsub-health] Failed to clear alert cooldown state in KV", {
      kvKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 通知経路ごとに独立したKVキーを組み立てる（shouldSendAlertのJSDoc参照）。 */
function alertStateKvKey(kind: "unhealthy" | "fetch-failed" | "secret-missing", environment: "production" | "preview"): string {
  return `${EVENTSUB_HEALTH_ALERT_KV_PREFIX}${kind}:${environment}`;
}

interface EventSubHealthResponse {
  total: number;
  unhealthyCount: number;
  unhealthy: Array<{
    id: string;
    type: string;
    status: string;
    broadcasterUserId: string | undefined;
    rewardId: string | undefined;
    createdAt: string;
  }>;
  checkedAt: string;
}

export async function GET(request: NextRequest) {
  // fail-closed: シークレット自体が未設定の場合は、設定忘れで誰でもアクセス
  // できてしまう事故を防ぐため 500 を返す（db-health/route.ts と同じ設計）。
  const expectedSecret = process.env.EVENTSUB_HEALTH_SECRET;
  if (!expectedSecret) {
    // Worker側secretだけ先に設定されアプリ側が未設定、という一時的な
    // デプロイ順序の過渡期でも5分毎に呼ばれうるため、他の通知経路と同じ
    // クールダウンゲートを通す（PR #1009 3回目のレビュー指摘・必須）。
    const environment = resolveEnvironment();
    const kv = await getKvBinding();
    const kvKey = alertStateKvKey("secret-missing", environment);
    const now = Date.now();
    if (await shouldSendAlert(kv, kvKey, "secret-missing", now)) {
      logger.error("[eventsub-health] EVENTSUB_HEALTH_SECRET is not configured");
      await recordAlertState(kv, kvKey, "secret-missing", now);
    }
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    );
  }

  const providedSecret = request.headers.get("x-eventsub-health-secret") || "";
  if (!providedSecret || !constantTimeEqual(expectedSecret, providedSecret)) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
  }

  // セッションが存在しない運用エンドポイントのため ip: ベースの識別子を使う
  // （db-health/route.ts と同じ方式）。
  const identifier = await getRateLimitIdentifier(request);
  const rateLimitResult = await checkRateLimit(rateLimits.eventsubHealth, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimitResult.limit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(rateLimitResult.reset),
        },
      }
    );
  }

  const environment = resolveEnvironment();
  const kv = await getKvBinding();

  try {
    const subscriptions = await listAllEventSubSubscriptions();
    const unhealthy = subscriptions.filter((sub) => isUnhealthyEventSubStatus(sub.status));
    const unhealthyDetails = unhealthy.map((sub) => ({
      id: sub.id,
      type: sub.type,
      status: sub.status,
      broadcasterUserId: sub.condition.broadcaster_user_id ?? sub.condition.to_broadcaster_user_id,
      rewardId: sub.condition.reward_id,
      createdAt: sub.created_at,
    }));
    const unhealthyAlertKey = alertStateKvKey("unhealthy", environment);
    const now = Date.now();

    if (unhealthy.length > 0) {
      // 5分毎に無条件でreportErrorすると、error-reporterがクールダウン無しで
      // 同一Issueへコメントを積み続けてしまう（このファイル冒頭のJSDoc
      // 「アラート頻度制御」節参照）。KVベースのクールダウン+変化検知ゲートを
      // 挟み、状況が変わらない限り最大1時間に1回まで間引く。
      const fingerprint = unhealthyFingerprint(unhealthy.map((sub) => sub.id));
      if (await shouldSendAlert(kv, unhealthyAlertKey, fingerprint, now)) {
        // reportError が console.error 出力とDB永続化（→GitHub Issue化）の両方を
        // 担うため、ここで別途 logger.warn を挟むと同じ検知内容を2箇所へ重複
        // ログすることになる。メッセージ文字列は environment ごとに固定
        // （buildUnhealthyAlertMessage のコメント参照）。可変情報はcontext側にのみ渡す。
        await reportError(new Error(buildUnhealthyAlertMessage(environment)), {
          environment,
          count: unhealthy.length,
          subscriptions: unhealthyDetails,
        });
        await recordAlertState(kv, unhealthyAlertKey, fingerprint, now);
      }
    } else {
      // 復旧した。KVへ前回のfingerprintを残したままにすると、後で同じ集合が
      // 再発(flapping)した際に「変化なし」と誤判定してクールダウンに握り
      // 潰されてしまうため、クールダウン状態自体を消しておく
      // （PR #1009 3回目のレビュー指摘・任意。TTLでも自然消滅するが、
      // flapping間隔がTTLより短いケースを塞ぐために即時clearする）。
      await clearAlertState(kv, unhealthyAlertKey);
    }

    const body: EventSubHealthResponse = {
      total: subscriptions.length,
      unhealthyCount: unhealthy.length,
      unhealthy: unhealthyDetails,
      checkedAt: new Date().toISOString(),
    };
    return NextResponse.json(body);
  } catch (error) {
    // Twitch API 呼び出し自体の失敗（app token発行失敗・Helix障害等）。
    // db-health/route.ts と異なりホスト名等の機密情報を含む余地は無いため、
    // エラーの message/stack はそのまま reportError の第2引数(context)に渡す
    // （レスポンスは汎用メッセージのみ）。message自体は environment ごとに
    // 固定する（buildFetchFailedAlertMessage 参照。fetch失敗の詳細ごとに
    // signatureを割らないため）。
    //
    // logger.error（fire-and-forget）ではなく reportError を直接 await する
    // 理由: 上のunhealthy検知分岐と同じ（このファイル冒頭のJSDoc「アラート
    // 方式」節参照）。この catch は Twitch API/app token 自体の障害という、
    // 本エンドポイントの目的（#527 のような無音の失敗を確実に検知する）
    // そのものに関わる経路であり、fire-and-forget にするとレスポンス返却後の
    // isolate 回収でDB書き込みが完走しない恐れがある。
    const err = error instanceof Error ? error : new Error(String(error));
    const now = Date.now();
    const fetchFailedAlertKey = alertStateKvKey("fetch-failed", environment);
    // fetch失敗はunhealthy検知と独立したクールダウンキーを使う（fingerprintは
    // 固定文字列。JSDoc「アラート頻度制御」節参照）ため、片方のスパム対策が
    // もう片方の再アラートまで巻き込んで抑制することはない。
    if (await shouldSendAlert(kv, fetchFailedAlertKey, "fetch-failed", now)) {
      await reportError(new Error(buildFetchFailedAlertMessage(environment)), {
        environment,
        context: "eventsub-health:fetchFailed",
        error: err.message,
        stack: err.stack,
      });
      await recordAlertState(kv, fetchFailedAlertKey, "fetch-failed", now);
    }
    return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 502 });
  }
}
