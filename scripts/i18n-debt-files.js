'use strict'

/**
 * i18n ハードコード日本語の負債リスト（#835）。
 *
 * eslint.i18n.config.mjs がこのリストに含まれるファイルを日本語リテラル検査から
 * 除外する（既存の膨大なハードコード日本語を一度に修正するとレビュー不能な規模になるため、
 * 負債として明示的に管理しながら、移設完了ファイルから順次除外していく運用）。
 *
 * 管理規約:
 * - ファイルの i18n 移設が完了したら、このリストからそのファイルを削除すること。
 *   削除されると `npm run lint:i18n` がそのファイルの日本語リテラルを検出して CI が赤くなる。
 * - 新規ファイルをこのリストに追加しないこと（新規コードは最初から i18n を守る）。
 */
module.exports = [
  'src/app/api/cards/batch-update/route.ts',
  'src/app/api/cards/batch/route.ts',
  'src/app/api/gacha/demo/route.ts',
  'src/app/api/storage-bonus/vote-campaign/route.ts',
  'src/app/api/streamer/additional-rewards/route.ts',
  'src/app/api/twitch/eventsub/subscribe/route.ts',
  'src/app/api/twitch/rewards/route.ts',
  'src/app/auth/callback-complete/page.tsx',
  'src/app/dashboard/page.tsx',
  'src/app/layout.tsx',
  'src/app/not-found.tsx',
  'src/app/overlay/[streamerId]/page.tsx',
  'src/app/plans/page.tsx',
  'src/app/releases/page.tsx',
  'src/components/CardPackModal.tsx',
  'src/components/ChatAnnouncementSettings.tsx',
  'src/components/ImageCropper.tsx',
  'src/components/LanguageSwitcher.tsx',
  'src/components/SupportPlanSection.tsx',
  'src/components/VoteCampaignReshowSetting.tsx',
  'src/lib/auth-error-handler.ts',
  'src/lib/card-issuance.ts',
  'src/lib/card-number-errors.ts',
  'src/lib/constants.ts',
  'src/lib/csrf.ts',
  'src/lib/db/schema.ts',
  'src/lib/maintenance/eventsub-park.ts',
  'src/lib/maintenance/guard.ts',
  'src/lib/r2-client.ts',
  'src/lib/services/eventsub-redemption.ts',
  'src/lib/twitch/chat-service.ts',
]
