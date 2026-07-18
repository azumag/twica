'use client'

import { useTranslations } from 'next-intl'
import type { MaintenanceMode } from '@/lib/maintenance/state'

interface MaintenanceAnnouncerProps {
  /** 現在の maintenance mode。'off' のときは何も読み上げない（後述）。 */
  mode: MaintenanceMode
  /**
   * 画面に表示される（または表示予定の）maintenance 文言。
   * 解決済みのテキストを呼び出し元から渡してもらう設計にした理由:
   * mode / publicMessageKey から実際の文言を選ぶロジックは、視覚的な
   * バナー表示を担当する Stage 6b 側と共有すべき単一の解決ロジックであり、
   * 通知専用の本コンポーネントに同じマッピングを重複実装すると、
   * 将来どちらか片方だけ更新されて表示内容と読み上げ内容がズレる事故の
   * もとになる。そのため本コンポーネントは「渡された文言をどう読み上げるか」
   * だけに責務を絞る。
   */
  message?: string
}

/**
 * maintenance 状態の変化をスクリーンリーダーへ通知する a11y 専用コンポーネント
 * (#694 Stage 6a)。
 *
 * 視覚的な表示は行わない（sr-only）。実際のバナー表示は Stage 6b で別途実装し、
 * 両方から同じ mode/message を渡すことで、視覚表示と読み上げ内容を常に一致させる。
 *
 * 常に DOM にマウントし続ける設計（mode==='off' でも早期 return しない）:
 * aria-live リージョンは「その要素が既に存在する状態で中身が変化したとき」に
 * 支援技術（スクリーンリーダー）へ通知される。要素ごと条件付きで
 * マウント/アンマウントすると、マウントと同時にテキストが挿入される
 * 初回ケースを多くの支援技術が正しく検知できず、最初の状態変化
 * （'off' -> 'read-only' 等）が読み上げられない事故になりうる。そのため
 * 空文字列 <-> 実際の文言、という「中身だけの変化」に一本化している。
 *
 * role="status" + aria-live="polite" の組み合わせは、本プロジェクトの
 * 既存パターン（src/components/AnnouncementBanner.tsx の非critical severity、
 * analysis/src/components/ErrorBanner.tsx の role="alert"+aria-live="assertive"
 * との対比）に合わせたもの。メンテナンス状態の通知は「今すぐ割り込んで
 * 読み上げるべき緊急事態」ではなく、ユーザーの現在の読み上げを妨げない
 * polite が適切（既存の403/エラー系だけ assertive、それ以外は polite という
 * 本プロジェクトの使い分けに整合する）。
 */
export default function MaintenanceAnnouncer({ mode, message }: MaintenanceAnnouncerProps) {
  const t = useTranslations('maintenance')
  const announcement = mode !== 'off' && message ? `${t('announcementLabel')}: ${message}` : ''

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  )
}
