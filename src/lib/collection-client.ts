/**
 * マイコレクション画面の client component 用の書き込みヘルパー (#1953)。
 *
 * preview では、トレード UI 用の `postTradeJson`（src/lib/trade-client.ts）を
 * 再利用している。main にはトレード機能のコード（trade-client と、その型の参照先
 * trade-api / trade / trade-auction）がまだ無いため、#1953 だけを先行リリースする際に
 * 必要な部分（POST + CSRF 復旧の 1 回再送）だけをここに切り出した。
 * 復旧手順は postTradeJson と同じにしてある:
 *   CSRF cookie は HttpOnly + 遅延発行（src/lib/csrf.ts）なので、未発行のまま POST すると
 *   403 CSRF_TOKEN_INVALID になる。その場合だけ GET /api/session で cookie を発行させ、
 *   1 回だけ再送する。
 * 呼び出し側（CollectionHideButton）は成否だけで表示を切り替えるため、エラーの種類
 * （メンテナンス応答・ネットワーク断など）は区別せず ok=false にまとめる。
 * このファイルはクライアントから import されるので、サーバー専用の依存を入れないこと。
 */
export async function postJsonWithCsrfRetry(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const init = (): RequestInit => ({
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  try {
    let res = await fetch(url, init());
    if (res.status === 403) {
      const data: unknown = await res.json().catch(() => null);
      if ((data as { code?: unknown } | null)?.code === "CSRF_TOKEN_INVALID") {
        const refresh = await fetch("/api/session", { credentials: "include", cache: "no-store" });
        if (refresh.ok) {
          res = await fetch(url, init());
        }
      }
    }
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}
