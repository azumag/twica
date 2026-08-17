import { type NextRequest, NextResponse } from "next/server";
import { ERROR_MESSAGES } from "@/lib/constants";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { logger } from "@/lib/logger.server";
import { constantTimeEqual } from "@/lib/crypto-utils";
import { reportError } from "@/lib/sentry/error-handler";
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
 * buildUnhealthyAlertMessage 参照）でグルーピングしながら GitHub Issue を
 * 自動作成・再発時はコメント追記する。そのため本routeは
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

/** `process.env.NEXT_PUBLIC_APP_URL` から environment を判定する。
 * `src/lib/sentry/error-handler.ts` の persistErrorToDatabase と同じロジック
 * （errors.environment 列の算出方法と一致させておく必要があるため、意図的な
 * 重複実装。フォローアップissueで共通化を検討）。 */
function resolveEnvironment(): "production" | "preview" {
  return (process.env.NEXT_PUBLIC_APP_URL || "").includes("preview") ? "preview" : "production";
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
    logger.error("[eventsub-health] EVENTSUB_HEALTH_SECRET is not configured");
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

  try {
    const subscriptions = await listAllEventSubSubscriptions();
    const unhealthy = subscriptions.filter((sub) => isUnhealthyEventSubStatus(sub.status));

    if (unhealthy.length > 0) {
      const environment = resolveEnvironment();
      // reportError が console.error 出力とDB永続化（→GitHub Issue化）の両方を
      // 担うため、ここで別途 logger.warn を挟むと同じ検知内容を2箇所へ重複
      // ログすることになる。メッセージ文字列は environment ごとに固定
      // （buildUnhealthyAlertMessage のコメント参照）。可変情報はcontext側にのみ渡す。
      await reportError(new Error(buildUnhealthyAlertMessage(environment)), {
        environment,
        count: unhealthy.length,
        subscriptions: unhealthy.map((sub) => ({
          id: sub.id,
          type: sub.type,
          status: sub.status,
          broadcasterUserId: sub.condition.broadcaster_user_id ?? sub.condition.to_broadcaster_user_id,
          rewardId: sub.condition.reward_id,
          createdAt: sub.created_at,
        })),
      });
    }

    const body: EventSubHealthResponse = {
      total: subscriptions.length,
      unhealthyCount: unhealthy.length,
      unhealthy: unhealthy.map((sub) => ({
        id: sub.id,
        type: sub.type,
        status: sub.status,
        broadcasterUserId: sub.condition.broadcaster_user_id ?? sub.condition.to_broadcaster_user_id,
        rewardId: sub.condition.reward_id,
        createdAt: sub.created_at,
      })),
      checkedAt: new Date().toISOString(),
    };
    return NextResponse.json(body);
  } catch (error) {
    // Twitch API 呼び出し自体の失敗（app token発行失敗・Helix障害等）。
    // db-health/route.ts と異なりホスト名等の機密情報を含む余地は無いため、
    // エラーの message/stack をそのまま reportError に渡す（レスポンスは
    // 汎用メッセージのみ）。
    //
    // logger.error（fire-and-forget）ではなく reportError を直接 await する
    // 理由: 上の UNHEALTHY_ALERT_MESSAGE 分岐と同じ（このコメント冒頭の
    // JSDoc「アラート方式」節参照）。この catch は Twitch API/app token 自体の
    // 障害という、本エンドポイントの目的（#527 のような無音の失敗を確実に
    // 検知する）そのものに関わる経路であり、fire-and-forget にすると
    // レスポンス返却後の isolate 回収でDB書き込みが完走しない恐れがある。
    const err = error instanceof Error ? error : new Error(String(error));
    await reportError(err, { context: "eventsub-health:fetchFailed" });
    return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 502 });
  }
}
