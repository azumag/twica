import { type NextRequest, NextResponse } from "next/server";
import { ERROR_MESSAGES } from "@/lib/constants";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { logger } from "@/lib/logger.server";
import { constantTimeEqual } from "@/lib/crypto-utils";
import { getDb, type DbHandle } from "@/lib/db/client";



/**
 * PlanetScale DB health/diagnostics エンドポイント (Issue #693/#708)。
 * 本routeは、認証済み運用者が実接続を
 * 機密情報（接続文字列・ホスト名・DB名）を露出せずに確認するための診断用
 * エンドポイント。
 *
 * スコープ外（YAGNI）: databaseIdentity/schemaDigest フィールドは実装しない。
 * これらは #691/#697 で作られる twica_meta.database_identity 相当のテーブルに
 * 依存するため、本issueの時点ではまだ存在しないテーブルへの参照を先回りして
 * 作らない。
 *
 * 認証: eventsub-replay/route.ts と同じ共有シークレットパターン（新規シークレット
 * DB_HEALTH_SECRET・ヘッダー X-Health-Secret・定数時間比較・未設定なら500
 * fail-closed・不一致なら403）。定数時間比較そのものは eventsub-replay/route.ts の
 * timingSafeEqualString を複製せず、src/lib/crypto-utils.ts に既存の
 * constantTimeEqual（用途・実装とも同一の定数時間文字列比較）を再利用する
 * （route.ts は Next.js の route handler 規約上 HTTP メソッド以外の named export を
 * 持たせない方針のため、eventsub-replay 側から直接 import するのではなく、
 * 既存の共有ユーティリティ側に寄せる判断とした）。
 */

interface DbHealthResponse {
  driver: string;
  target: "planetscale";
  serverVersionMajor: number | null;
  latencyMs: number;
  error?: string;
}

export async function GET(request: NextRequest) {
  // fail-closed: シークレット自体が未設定の場合は、設定忘れで誰でもアクセス
  // できてしまう事故を防ぐため 500 を返す（eventsub-replay/route.ts と同じ設計）。
  const expectedSecret = process.env.DB_HEALTH_SECRET;
  if (!expectedSecret) {
    logger.error("[db-health] DB_HEALTH_SECRET is not configured");
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    );
  }

  const providedSecret = request.headers.get("x-health-secret") || "";
  if (!providedSecret || !constantTimeEqual(expectedSecret, providedSecret)) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
  }

  // セッションが存在しない運用エンドポイントのため ip: ベースの識別子を使う
  // （eventsub-replay/route.ts と同じ方式）。
  const identifier = await getRateLimitIdentifier(request);
  const rateLimitResult = await checkRateLimit(rateLimits.dbHealth, identifier);

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

  // #708: 接続先は PlanetScale のみ。旧 target=supabase を明示した呼び出しは
  // 停止済み DB へ到達させず 400 で拒否する。
  const rawTarget = request.nextUrl.searchParams.get("target");
  if (rawTarget !== null && rawTarget !== "planetscale") {
    return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
  }
  const target = "planetscale" as const;

  const driver = 'pg';
  const startedAt = Date.now();

  // getDb() 自体の失敗（Hyperdrive binding 不足・DATABASE_URL 未設定等の
  // target解決失敗）と、実クエリ発行時の失敗（DNS/認証/タイムアウト等の実接続
  // エラー）を分けて扱う。前者は resolveConnectionString（src/lib/db/client.ts）が
  // 投げる `[db:pg]` prefix付きメッセージ（env var名・binding名のみを含み機密情報を
  // 含まない）であればそのまま返してよいが、getDb() はそれ以外に postgres() 自体の
  // コンストラクタ例外（不正な接続文字列由来等、実行環境=workerdでの文言形式は未検証）
  // も伝播しうり、そちらはホスト名等を含む可能性があるため無条件echoは避ける。
  // 後者（実クエリ、postgres.js/ドライバのエラー）と同じ汎用メッセージへ
  // フォールバックし、詳細はログにのみ残す（issue #693 の「database名やhost等の
  // 機密情報は露出しない」要件）。
  let sql: DbHandle["sql"];
  try {
    ({ sql } = await getDb());
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[db-health] target resolution failed", { target, error: message });
    // `[db:pg]` prefixは安全性が保証されたメッセージのみに付与される
    // （resolveConnectionStringのthrow文参照）。それ以外は汎用文言にフォールバック。
    const safeMessage = message.startsWith("[db:pg]")
      ? message
      : "database connection check failed";
    const body: DbHealthResponse = {
      driver,
      target,
      serverVersionMajor: null,
      latencyMs,
      error: safeMessage,
    };
    return NextResponse.json(body);
  }

  try {
    // server_version_num は整数（例 150004 = PostgreSQL 15.4）で返る安定した
    // current_setting。SELECT version() / SHOW server_version のようなバナー
    // 文字列と違いOS情報等を含まず、メジャーバージョンの抽出も単純な整数除算で
    // 済むため、こちらを使う（ホスト名・DB名は一切含まれない）。
    const rows =
      await sql`SELECT current_setting('server_version_num')::int AS version_num`;
    const versionNum = (rows[0] as { version_num?: number } | undefined)?.version_num;
    const serverVersionMajor =
      typeof versionNum === "number" ? Math.floor(versionNum / 10000) : null;
    const latencyMs = Date.now() - startedAt;

    const body: DbHealthResponse = { driver, target, serverVersionMajor, latencyMs };
    return NextResponse.json(body);
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[db-health] connection check query failed", { target, error: message });
    const body: DbHealthResponse = {
      driver,
      target,
      serverVersionMajor: null,
      latencyMs,
      // 実接続エラーはホスト名等を含みうるため、レスポンスには汎用メッセージのみ
      // 返す（詳細は上の logger.warn に残る）。
      error: "database connection check failed",
    };
    return NextResponse.json(body);
  }
}
