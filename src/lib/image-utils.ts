/**
 * Cloudflare Images Transformations を利用した画像最適化ユーティリティ
 *
 * URL形式: https://<CF_PROXIED_DOMAIN>/cdn-cgi/image/<OPTIONS>/<ORIGINAL_URL>
 * onerror=redirect により、無料枠超過時はオリジナル画像へ自動フォールバック
 *
 * 重要: 同一ゾーン（bluemoon.works）上の画像のみ変換対象とする。
 * 異なるオリジン（r2.dev等）の画像を変換しようとすると 403 Forbidden になり、
 * onerror=redirect は変換処理前の 403 には効かないため、画像が表示されなくなる。
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

// CF Images Transformations で変換可能なドメイン（同一ゾーン内のみ）
// "Resize images from any origin" を有効にしない限り、
// 異なるオリジンの画像は 403 Forbidden になる
const TRANSFORMABLE_DOMAIN = ".bluemoon.works";

/**
 * Cloudflare Images Transformations を使った最適化URLを生成
 *
 * - NEXT_PUBLIC_CF_IMAGES_ENABLED=true かつ NEXT_PUBLIC_APP_URL が https:// の場合のみ変換
 * - 同一ゾーン（bluemoon.works）上の画像URLのみ変換対象
 * - 外部ドメイン（r2.dev、Twitch CDN等）の画像はオリジナルURLを返す
 * - null/空文字列の場合はそのまま返す
 *
 * @param url - オリジナル画像URL
 * @param preset - 変換プリセット ('thumbnail' | 'icon')
 * @returns 最適化された画像URL、または変換不可の場合はオリジナルURL
 */
export function getOptimizedImageUrl(url: string, preset: ImagePreset): string;
export function getOptimizedImageUrl(url: string | null, preset: ImagePreset): string | null;
export function getOptimizedImageUrl(
  url: string | null,
  preset: ImagePreset
): string | null {
  // null → null, "" → "" でそれぞれの型契約を維持
  if (!url) return url;

  // NEXT_PUBLIC_* はビルド時にインライン化される（Cloudflare Workers環境）
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  const enabled = process.env.NEXT_PUBLIC_CF_IMAGES_ENABLED === "true";

  // CFプロキシ配下でない環境（localhost/http、またはフラグ未設定）ではスキップ
  if (!enabled || !appUrl.startsWith("https://")) {
    return url;
  }

  // 同一ゾーン外の画像は変換不可（403 Forbidden になるため）
  try {
    const hostname = new URL(url).hostname;
    if (!hostname.endsWith(TRANSFORMABLE_DOMAIN)) {
      return url;
    }
  } catch {
    // 不正なURLはそのまま返す
    return url;
  }

  const options = PRESETS[preset];
  return `${appUrl}/cdn-cgi/image/${options}/${url}`;
}
