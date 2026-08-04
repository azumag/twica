const TWITCH_AUTHORIZATION_ORIGIN = 'https://id.twitch.tv'
const TWITCH_AUTHORIZATION_PATH = '/oauth2/authorize'

export interface TwitchAuthorizationResponse {
  loginUrl: string
  state: string
}

/**
 * reauth/BOT接続などOAuth開始APIの成功bodyを、ブラウザ遷移へ使ってよいTwitch OAuth URLへ正規化する。
 *
 * 型確認だけでは、壊れたAPI応答や侵害時の外部URLを `window.location` へ渡してしまう。
 * Twitch公式の認可endpoint（https://id.twitch.tv/oauth2/authorize）に限定し、URL内の
 * stateとAPI応答のstateが一致することまで確認してから遷移する。本人再認証とBOT接続の
 * 2つのCTAが同じOAuth/CSRF境界を共有し、片方だけ検証が弱くなる回帰を防ぐ（Issue #865）。
 */
export function parseTwitchAuthorizationResponse(body: unknown): TwitchAuthorizationResponse | null {
  if (typeof body !== 'object' || body === null) return null

  const { loginUrl, state } = body as Record<string, unknown>
  if (typeof loginUrl !== 'string' || typeof state !== 'string' || state.length === 0) {
    return null
  }

  try {
    const url = new URL(loginUrl)
    if (
      url.origin !== TWITCH_AUTHORIZATION_ORIGIN ||
      url.pathname !== TWITCH_AUTHORIZATION_PATH ||
      url.username !== '' ||
      url.password !== '' ||
      url.searchParams.get('state') !== state
    ) {
      return null
    }
    return { loginUrl: url.href, state }
  } catch {
    return null
  }
}
