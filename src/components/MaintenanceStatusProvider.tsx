'use client'

/**
 * Maintenance mode: ダッシュボード全体で共有する状態プロバイダ (#694 Stage 6b)
 *
 * 設計判断（状態共有をContextにした理由）:
 * MaintenanceBanner と各書き込みボタン（CardManager, BatchDropRateManualContent,
 * CardVisibilitySettings 等）がそれぞれ個別に fetchMaintenanceStatus() を呼ぶと、
 * ダッシュボードページ1枚あたりのAPIコール数が「バナー1 + 書き込みボタンの数」に
 * 比例して増えてしまう。ダッシュボードのページ内には書き込みボタンが同時に何個も
 * 存在しうる（カード編集フォーム・ドロップ率保存・設定トグル等）ため、素朴に
 * 各コンポーネントが自前でポーリングするとページ表示のたびに数倍のAPIコールが
 * 発生する。dashboard/layout.tsx にProviderを1つ置き、1つのpollingタイマーが
 * 取得した状態をContext経由で全消費者に配る設計にすることで、ページあたりの
 * maintenance-status APIコール数を「1ページ = 1 polling系列」に固定する。
 *
 * ポーリング間隔（60秒）の設計根拠:
 * - maintenance mode の切替はオペレーターの手動操作（env var変更 + デプロイ）で
 *   発生する低頻度イベントであり、秒単位の即時反映は要求されない
 *   （issue #694 の受け入れ条件にも「即時反映」の要求はない）。
 * - 一方で、メンテ解除後にバナーが消えるまで/書き込みボタンが再度有効になるまで
 *   の体感待ち時間は短いほど良い。60秒は「サーバー負荷を抑えつつ、解除後
 *   1分以内にはUIが追従する」という妥当なバランス値として選んだ。
 * - ページロード時に必ず1回即時fetchするため、ページを開いた瞬間の状態は
 *   常に最新（60秒待たされない）。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { fetchMaintenanceStatus, type MaintenanceStatusResponse } from '@/lib/maintenance/client'

/** ポーリング間隔（ミリ秒）。設計根拠は上記ファイル冒頭コメント参照。 */
const POLL_INTERVAL_MS = 60_000

/**
 * fetchMaintenanceStatus() 自体が fail-safe に { mode: 'off' } を返す設計
 * （client.ts参照）なので、Context の初期値も同じ安全側のデフォルトに揃える。
 * これにより、初回fetch完了前の一瞬（またはProviderが無い文脈で誤って
 * useContextした場合）も「通常運用中」として振る舞い、誤ってバナー表示・
 * ボタンdisableが先走ることを防ぐ。
 */
const OFF_STATUS: MaintenanceStatusResponse = { mode: 'off' }

/**
 * 生の Context をテスト用に export する。アプリケーションコードは
 * useMaintenanceStatus() hook を使うのが基本だが、単体テストで
 * 「maintenance中の状態」を注入する際に MaintenanceStatusProvider の非同期
 * fetch（jsdom環境でのタイマー制御が必要になり煩雑）を経由せず、
 * `<MaintenanceStatusContext.Provider value={{ mode: 'read-only' }}>` で
 * 直接状態を差し込めるようにするための意図的な公開。
 */
export const MaintenanceStatusContext = createContext<MaintenanceStatusResponse>(OFF_STATUS)

/**
 * 現在の maintenance status を読む hook。
 * MaintenanceStatusProvider の外で呼んだ場合は createContext のデフォルト値
 * （OFF_STATUS）を返す（Provider未設置環境でも「通常運用中」という安全側の
 * 挙動になるだけで、例外にはしない）。
 */
export function useMaintenanceStatus(): MaintenanceStatusResponse {
  return useContext(MaintenanceStatusContext)
}

interface MaintenanceStatusProviderProps {
  children: ReactNode
}

/**
 * dashboard/layout.tsx に1つだけ配置するプロバイダ。
 * マウント時に即時fetchし、以降 POLL_INTERVAL_MS 間隔でポーリングする。
 */
export function MaintenanceStatusProvider({ children }: MaintenanceStatusProviderProps) {
  const [status, setStatus] = useState<MaintenanceStatusResponse>(OFF_STATUS)

  useEffect(() => {
    // アンマウント後にfetch完了してsetStateする（React警告・不要な再レンダー）
    // のを防ぐためのガード。dashboard内ページ遷移でlayoutごとアンマウントされる
    // ケースを想定。
    let cancelled = false

    const load = async () => {
      const next = await fetchMaintenanceStatus()
      if (!cancelled) {
        setStatus(next)
      }
    }

    load()
    const intervalId = setInterval(load, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [])

  return (
    <MaintenanceStatusContext.Provider value={status}>
      {children}
    </MaintenanceStatusContext.Provider>
  )
}
