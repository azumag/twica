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
 * - 可視状態でページを開いた時と、hiddenからvisibleへ戻った時に即時fetch
 *   するため、ユーザーが見る状態は60秒待たず最新になる。hidden中は不要な
 *   Worker invocationを止める。
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { fetchMaintenanceStatus, type MaintenanceStatusResponse } from '@/lib/maintenance/client'

/** ポーリング間隔（ミリ秒）。設計根拠は上記ファイル冒頭コメント参照。 */
const POLL_INTERVAL_MS = 60_000

/**
 * fetchMaintenanceStatus() 自体が fail-safe に { mode: 'off' } を返す設計
 * （client.ts参照）なので、Context の初期値も同じデフォルトに揃える。
 * Provider外と初期visible mountの確認待ちは、既存契約どおり「通常運用中」として
 * 振る舞う。初回取得失敗時もサーバー側guardWriteが最終的にwriteを拒否するため、
 * この契約をhidden対応のために広げて変更しない。
 */
export interface MaintenanceStatusContextValue extends MaintenanceStatusResponse {
  /**
   * hiddenからvisibleへ戻った直後の再確認中だけtrue。
   * modeはwriteをfail-closedにするためread-onlyだが、実メンテナンスと確定した
   * 状態ではないので、バナーやaria-live通知には使わない。
   */
  isRefreshing?: boolean
}

const OFF_STATUS: MaintenanceStatusContextValue = { mode: 'off' }

/**
 * hiddenからvisibleへ戻った直後だけ使う、再確認中のwrite-blocking状態。
 * 既存consumerは例外なく `mode !== 'off'` をwrite不可として扱うため、modeは
 * read-onlyのままにする。一方、可視バナーがこの暫定値を実メンテナンスと誤認して
 * 一瞬表示されないよう、Context内だけのisRefreshingで確定状態と区別する。
 */
const VISIBILITY_REFRESH_STATUS: MaintenanceStatusContextValue = {
  mode: 'read-only',
  isRefreshing: true,
}

/**
 * 生の Context をテスト用に export する。アプリケーションコードは
 * useMaintenanceStatus() hook を使うのが基本だが、単体テストで
 * 「maintenance中の状態」を注入する際に MaintenanceStatusProvider の非同期
 * fetch（jsdom環境でのタイマー制御が必要になり煩雑）を経由せず、
 * `<MaintenanceStatusContext.Provider value={{ mode: 'read-only' }}>` で
 * 直接状態を差し込めるようにするための意図的な公開。
 */
export const MaintenanceStatusContext = createContext<MaintenanceStatusContextValue>(OFF_STATUS)

/**
 * 現在の maintenance status を読む hook。
 * MaintenanceStatusProvider の外で呼んだ場合は createContext のデフォルト値
 * （OFF_STATUS）を返す（Provider未設置環境でも「通常運用中」という安全側の
 * 挙動になるだけで、例外にはしない）。
 */
export function useMaintenanceStatus(): MaintenanceStatusContextValue {
  return useContext(MaintenanceStatusContext)
}

interface MaintenanceStatusProviderProps {
  children: ReactNode
}

/**
 * dashboard/layout.tsx に1つだけ配置するプロバイダ。
 * 可視状態で即時fetchし、以降 POLL_INTERVAL_MS 間隔でポーリングする。
 */
export function MaintenanceStatusProvider({ children }: MaintenanceStatusProviderProps) {
  const [status, setStatus] = useState<MaintenanceStatusContextValue>(OFF_STATUS)

  useEffect(() => {
    // アンマウント後にfetch完了してsetStateする（React警告・不要な再レンダー）
    // のを防ぐためのガード。dashboard内ページ遷移でlayoutごとアンマウントされる
    // ケースを想定。
    let cancelled = false
    let intervalId: ReturnType<typeof setInterval> | null = null
    // hidden切替後や新しいvisible refresh後に古いrequestが完了しても、その
    // responseで最新statusを上書きしないための世代番号。共有fetch helperへ
    // AbortSignalを追加せず、このProvider内だけで競合を閉じ込める。
    let requestGeneration = 0

    const load = async (blockWritesWhileLoading = false) => {
      const generation = ++requestGeneration

      if (blockWritesWhileLoading) {
        // visible復帰時はhidden中にサーバーがread-onlyへ変わった可能性があるため、
        // request完了まで古いoffを公開しない。既に非offならwriteは無効化済みなので、
        // expectedEndAt等の実status詳細を一時値で消さず、その状態を維持する。
        setStatus((current) => (
          current.mode === 'off' ? VISIBILITY_REFRESH_STATUS : current
        ))
      }

      const next = await fetchMaintenanceStatus()
      if (!cancelled && generation === requestGeneration) {
        setStatus(next)
      }
    }

    const stopPolling = () => {
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
    }

    const startPolling = (blockWritesWhileLoading = false) => {
      if (
        cancelled
        || document.visibilityState === 'hidden'
        || intervalId !== null
      ) {
        return
      }
      void load(blockWritesWhileLoading)
      intervalId = setInterval(() => void load(), POLL_INTERVAL_MS)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopPolling()
        // 可視中に開始したrequestがhidden後にsetStateしないよう無効化する。
        requestGeneration += 1
        return
      }
      // startPollingのintervalId guardで重複visible eventによる多重timerを防ぐ。
      // 再開時はwriteを一時無効化して即時loadし、既存60秒cadenceへ戻る。
      startPolling(true)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    // 初期visible mountはOFF_STATUSを保つ既存Context契約のまま即時取得する。
    // fail-closedにするのは、既知の状態がhidden中に陳腐化した復帰時だけに限定する。
    startPolling()

    return () => {
      cancelled = true
      requestGeneration += 1
      stopPolling()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  return (
    <MaintenanceStatusContext.Provider value={status}>
      {children}
    </MaintenanceStatusContext.Provider>
  )
}
