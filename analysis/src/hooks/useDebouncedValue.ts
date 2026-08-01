import { useEffect, useState } from 'react'

/**
 * 指定した値の通知を遅延させ、保留中の通知を取り消す関数を返す。
 *
 * タイマーのライフサイクルをhook本体から分離しておくと、Reactのrendererを
 * 必要とせずに「古い値のタイマーをcleanupして最新値だけ通知する」という
 * デバウンスの本体を検証できる。hookはこのcleanupをuseEffectの戻り値として
 * そのまま返すため、再レンダー時とアンマウント時の既存の動作も維持される。
 */
export function scheduleDebouncedValue<T>(
  value: T,
  delayMs: number,
  onValue: (value: T) => void,
): () => void {
  const timer = setTimeout(() => onValue(value), delayMs)
  return () => clearTimeout(timer)
}

/**
 * 値が最後に変更されてから指定時間が経過したときだけ、最新値を返す。
 *
 * 検索入力をそのままDB検索の依存値にすると、1文字入力するたびに
 * `get_analysis_*_page` が実行される。これらのRPCはページ行だけでなく正確な
 * countと全体summaryも計算するため、入力中の中間値を毎回検索するのはDB負荷と
 * レスポンス競合を不必要に増やす。hook側でタイマーを一元管理し、入力が続く間は
 * 保留、入力が止まった後の最新値だけを一覧APIへ渡す。
 *
 * cleanupで前回のタイマーを必ず破棄するため、連続入力中に古い検索語が後から
 * stateへ反映されることも防ぐ。呼び出し側がアンマウントされた場合も同じcleanupが
 * 走り、アンマウント後のstate更新を発生させない。
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(
    () => scheduleDebouncedValue(value, delayMs, setDebouncedValue),
    [value, delayMs]
  )

  return debouncedValue
}
