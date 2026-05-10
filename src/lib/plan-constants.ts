/**
 * Support Plan Constants
 * 支援プラン定数定義
 *
 * クライアントコンポーネントからも安全に import できるよう、
 * サーバー専用モジュール（DB・API 等）への依存を持たない純粋な定数ファイル。
 */

export type PlanType = 'basic' | 'support' | 'patron' | 'twitch_sub'

// プランごとの追加ストレージ容量（バイト）
// basic: 追加なし, support: 250MB, patron/twitch_sub: 500MB
export const PLAN_STORAGE_BONUS: Record<PlanType, number> = {
  basic: 0,
  support: 250 * 1024 * 1024,       // 250MB
  patron: 500 * 1024 * 1024,        // 500MB
  twitch_sub: 500 * 1024 * 1024,    // 500MB（patron同等）
}

// プランごとのカード画像最大幅（ピクセル）
// basic: 800px（標準）, support: 1920px（Full HD）, patron/twitch_sub: 3840px（4K）
export const PLAN_MAX_IMAGE_WIDTH: Record<PlanType, number> = {
  basic: 800,
  support: 1920,
  patron: 3840,
  twitch_sub: 3840,    // patron同等
}

// プランごとのアップロードファイルサイズ上限（バイト）
// 高解像度画像はファイルサイズが大きくなるため、上位プランでは上限を引き上げ
// patron/twitch_sub(4K)はcanvas.toBlob(85%)で5MB超になりうるため10MBに設定
export const PLAN_MAX_UPLOAD_SIZE: Record<PlanType, number> = {
  basic: 1 * 1024 * 1024,     // 1MB
  support: 5 * 1024 * 1024,   // 5MB（Full HD JPEG対応）
  patron: 10 * 1024 * 1024,   // 10MB（4K JPEG対応）
  twitch_sub: 10 * 1024 * 1024, // 10MB（patron同等）
}

// プランごとの選択可能な出力幅（ピクセル）
// basic: 800pxのみ, support: 800/1920px, patron/twitch_sub: 800/1920/3840px
export const PLAN_AVAILABLE_WIDTHS: Record<PlanType, number[]> = {
  basic: [800],
  support: [800, 1920],
  patron: [800, 1920, 3840],
  twitch_sub: [800, 1920, 3840],
}

// プランの優先度（高い値が優先）
// twitch_sub は patron と同等（priority: 2）
export const PLAN_PRIORITY: Record<PlanType, number> = {
  basic: 0,
  support: 1,
  patron: 2,
  twitch_sub: 2,
}

// プランごとの動画カード枠数
// basic: 数枠まで無料, support以上: 支援者向けに追加枠
export const PLAN_VIDEO_CARD_LIMIT: Record<PlanType, number> = {
  basic: 3,
  support: 10,
  patron: 30,
  twitch_sub: 30,
}
