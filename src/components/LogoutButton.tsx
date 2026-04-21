'use client'

import { useTransition } from 'react'

interface LogoutButtonProps {
  className?: string
  label: string
  children: React.ReactNode
}

/**
 * ログアウト用クライアントコンポーネント。
 * 状態変更操作を GET リンクで実行するとプリフェッチやクローラで誤発火し得るため、
 * 明示的に POST で /api/auth/logout を叩く（OWASP CSRF Prevention に準拠）。
 * サーバー側は validateCSRFToken が HttpOnly CSRF Cookie と Origin を検証する。
 */
export function LogoutButton({ className, label, children }: LogoutButtonProps) {
  const [isPending, startTransition] = useTransition()

  const tryLogout = async (): Promise<Response> => {
    return fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
  }

  const refreshCsrfToken = async (): Promise<boolean> => {
    try {
      const response = await fetch('/api/session', {
        credentials: 'include',
        cache: 'no-store',
      })

      return response.ok
    } catch {
      return false
    }
  }

  const handleLogout = () => {
    startTransition(async () => {
      try {
        let response = await tryLogout()

        // CSRF cookie だけが欠けている不整合セッションでは、/api/session で
        // トークンを再発行してから一度だけ logout を再試行する。
        if (response.status === 403 && await refreshCsrfToken()) {
          response = await tryLogout()
        }

        // 正常リダイレクト時のみ指定 URL へ遷移し、それ以外は reload で
        // サーバー側のセッション状態を真実として再評価する（403/429 でログアウト失敗時に
        // 「/」へ静かに飛んで成功表示するのを防ぐ）。
        if (response.redirected) {
          window.location.href = response.url
        } else {
          window.location.reload()
        }
      } catch {
        // ネットワーク失敗時はサーバー状態を取り直すためリロードする
        window.location.reload()
      }
    })
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={isPending}
      aria-busy={isPending}
      className={className}
      title={label}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  )
}
