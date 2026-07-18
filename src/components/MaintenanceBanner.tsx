'use client'

/**
 * Maintenance mode: 視覚的バナー (#694 Stage 6b)
 *
 * MaintenanceAnnouncer（a11y専用、sr-only）とは別に、ダッシュボード上に常時
 * 見える形でメンテナンス状態を表示する。両者を1コンポーネントに統合する理由:
 * 呼び出し元（dashboard/layout.tsx）が「視覚表示」と「読み上げ通知」を別々に
 * 呼ぶと、将来どちらか一方だけ組み込み忘れる／文言をズレて渡す事故のリスクが
 * ある。本コンポーネント1つをレイアウトに置けば両方が常に同じ mode/message で
 * 揃う。
 *
 * 状態取得は useMaintenanceStatus() 経由（MaintenanceStatusProvider が
 * dashboard/layout.tsx で提供する共有Context）。書き込みボタン側と同じ
 * pollingデータソースを共有するため、このコンポーネント自身は追加のfetchを
 * 行わない。
 */
import { useLocale, useTranslations } from 'next-intl'
import type { MaintenanceMode } from '@/lib/maintenance/state'
import { useMaintenanceStatus } from './MaintenanceStatusProvider'
import MaintenanceAnnouncer from './MaintenanceAnnouncer'

/**
 * mode（kebab-case）から messages/*.json の `maintenance.modes.*`（camelCase）
 * キーへのマッピング。state.ts の MAINTENANCE_ERROR_CODE_BY_MODE と同様、
 * 手書きの対応表をここに1箇所だけ持つ。
 */
const MODE_TRANSLATION_KEYS: Record<Exclude<MaintenanceMode, 'off'>, string> = {
  'read-only': 'modes.readOnly',
  'cutover-validating': 'modes.cutoverValidating',
  'incident-read-only': 'modes.incidentReadOnly',
}

/**
 * expectedEndAt（ISO 8601文字列）をロケール依存の時刻表示に整形する。
 * CollectionProgress.tsx の formatDateTime と同じ方針（Intl.DateTimeFormat +
 * useLocale）。不正な値は null を返し、呼び出し側は「再開予定時刻なし」として
 * 扱う（バナー自体は expectedEndAt なしでも表示できるため、ここで例外にしない）。
 */
function formatResumeTime(expectedEndAt: string, locale: string): string | null {
  const parsed = new Date(expectedEndAt)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(parsed)
}

export default function MaintenanceBanner() {
  const { mode, expectedEndAt, publicMessageKey } = useMaintenanceStatus()
  const locale = useLocale()
  const t = useTranslations('maintenance')

  if (mode === 'off') {
    // 視覚的なバナーdivは描画しないが、MaintenanceAnnouncer自体は常時マウントし
    // 続ける。MaintenanceAnnouncerのdocコメントが警告する事故（aria-live要素の
    // マウントと同時にテキストが挿入されると、多くの支援技術が初回の変化を
    // 読み上げない）は、このコンポーネント自身が mode に応じてマウント/
    // アンマウントを繰り返すと再現してしまう。そのためMaintenanceAnnouncerだけは
    // mode に関わらず常に描画し、「中身（message）だけが空文字←→実際の文言に
    // 変化する」という同コンポーネントが要求する形を維持する。
    return <MaintenanceAnnouncer mode={mode} />
  }

  // publicMessageKey が辞書（messages.maintenance.messageKeys.*）に存在すれば
  // それを優先し、無ければ mode 別デフォルト文言にフォールバックする。
  // この解決規約は src/lib/maintenance/client.ts の MaintenanceStatusResponse
  // ドキュメントコメントに明記されたもの（Stage 6a時点で先に規約だけ決めてあった）。
  const messageKeyPath = publicMessageKey ? `messageKeys.${publicMessageKey}` : null
  const message =
    messageKeyPath && t.has(messageKeyPath) ? t(messageKeyPath) : t(MODE_TRANSLATION_KEYS[mode])

  const resumeTime = expectedEndAt ? formatResumeTime(expectedEndAt, locale) : null

  return (
    <>
      <MaintenanceAnnouncer mode={mode} message={message} />
      {/*
        role="status"（aria-live相当）はあえて付けない: 読み上げ責務は常時
        マウントされているMaintenanceAnnouncer側に一本化している。この可視div
        自体はmodeに応じてマウント/アンマウントされるため、ここにもaria-live
        系roleを付けると「マウントと同時にテキストが挿入」される構成になり、
        MaintenanceAnnouncerと二重にライブリージョンを持つことになる
        （支援技術によっては同じ内容が二重に読み上げられる、または
        MaintenanceAnnouncer同様マウント直後の変化を取りこぼす）。可視ユーザー
        向けの表示と、スクリーンリーダー向けの状態変化通知を明確に分離する。
      */}
      <div className="mb-4 flex flex-col gap-1 rounded-xl border border-yellow-600/50 bg-gradient-to-r from-yellow-900/50 to-amber-900/50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <span className="font-medium text-yellow-200">{message}</span>
        {resumeTime && (
          <span className="text-yellow-300/80">{t('resumeAt', { time: resumeTime })}</span>
        )}
      </div>
    </>
  )
}
