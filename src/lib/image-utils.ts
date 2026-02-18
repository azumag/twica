/**
 * Cloudflare Images Transformations を利用した画像最適化ユーティリティ
 *
 * URL形式: https://<CF_PROXIED_DOMAIN>/cdn-cgi/image/<OPTIONS>/<ORIGINAL_URL>
 * onerror=redirect により、無料枠超過時はオリジナル画像へ自動フォールバック
 *
 * 注意: NEXT_PUBLIC_APP_URL はNext.jsビルド時にインライン化される。
 * preview/production で異なるURLを使う場合はビルドごとに正しい値を設定すること。
 *
 * @see https://developers.cloudflare.com/images/transform-images/transform-via-url/
 */

// プリセット別の変換オプション
// thumbnail: グリッド/一覧のサムネイル用 (300px)
// icon: リスト表示の小アイコン用 (96px = 48px × 2 retina)
const PRESETS = {
  thumbnail: "width=300,format=auto,quality=80,onerror=redirect",
  icon: "width=96,format=auto,quality=80,onerror=redirect",
} as const;

export type ImagePreset = keyof typeof PRESETS;

/**
 * Cloudflare Images Transformations を使った最適化URLを生成
 *
 * - NEXT_PUBLIC_APP_URL が https:// の場合のみ変換URL生成（開発環境はスキップ）
 * - null/空文字列の場合はそのまま返す
 *
 * @param url - オリジナル画像URL
 * @param preset - 変換プリセット ('thumbnail' | 'icon')
 * @returns 最適化された画像URL、または開発環境ではオリジナルURL
 */
export function getOptimizedImageUrl(url: string, preset: ImagePreset): string;
export function getOptimizedImageUrl(url: string | null, preset: ImagePreset): string | null;
export function getOptimizedImageUrl(
  url: string | null,
  preset: ImagePreset
): string | null {
  if (!url) return null;

  // NEXT_PUBLIC_APP_URL はビルド時にインライン化される（Cloudflare Workers環境）
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";

  // 開発環境(localhost/http)では変換をスキップしてオリジナルURLを返す
  // Cloudflare Images Transformations はCFプロキシ経由のみ動作するため
  if (!appUrl.startsWith("https://")) {
    return url;
  }

  const options = PRESETS[preset];
  return `${appUrl}/cdn-cgi/image/${options}/${url}`;
}
