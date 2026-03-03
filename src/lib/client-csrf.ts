/**
 * クライアントサイドでCookieからCSRFトークンを取得する共通ユーティリティ。
 * サーバーサイド版は csrf.ts で管理。
 */
export function getCsrfTokenFromCookie(): string {
  if (typeof document === "undefined") return "";
  return (
    document.cookie
      .split("; ")
      .find((row) => row.startsWith("csrf_token="))
      ?.split("=")[1] || ""
  );
}
