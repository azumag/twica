const TWITCH_AUTHORIZATION_ORIGIN = 'https://id.twitch.tv'
const TWITCH_AUTHORIZATION_PATH = '/oauth2/authorize'
// サーバー側の生成方式はcrypto.randomUUID()（36文字、16進数+ハイフン）または
// randomBytesHex(32)（64文字、16進数のみ）のいずれかで、他の文字は使わない。
// ここで許可文字を絞ることで、stateが後段でdocument.cookieへ直接埋め込まれる
// 呼び出し元（例: "abc; Domain=evil.com; Path=/"）でのcookie属性インジェクションを防ぐ。
const STATE_PATTERN = /^[A-Za-z0-9-]{8,256}$/

export interface TwitchAuthorizationResponse {
  loginUrl: string
  state: string
}

/**
 * OAuth認可URLの `redirect_uri` が自アプリのoriginと一致するかを確認する。
 *
 * origin/path/stateの検証だけでは、侵害された応答が正規のTwitch認可URLの
 * `client_id`・`redirect_uri` だけ攻撃者のものへ差し替えて返すOAuth consent
 * phishingを防げない（Issue #869）。`client_id`の検証には環境別の期待値を
 * `NEXT_PUBLIC_`化して持つ必要がありスコープが大きいため別issueとするが、
 * `redirect_uri`のorigin一致は秘密情報を新たに公開せずクライアント側で
 * 安価に検証でき、consent phishingの実効性を大きく下げられる。
 *
 * この関数は必ずブラウザ内（クリックイベント/useEffect経由）で呼ばれる
 * client componentからのみ使われるためwindowは常に存在する前提だが、
 * 万一存在しない場合はfail-closedでfalseを返す。
 */
function isSameOriginRedirectUri(redirectUri: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URL(redirectUri).origin === window.location.origin
  } catch {
    return false
  }
}

/**
 * reauth/BOT接続などOAuth開始APIの成功bodyを、ブラウザ遷移へ使ってよいTwitch OAuth URLへ正規化する。
 *
 * 型確認だけでは、壊れたAPI応答や侵害時の外部URLを `window.location` へ渡してしまう。
 * Twitch公式の認可endpoint（https://id.twitch.tv/oauth2/authorize）に限定し、URL内の
 * stateとAPI応答のstateが一致すること、`redirect_uri`が自アプリのoriginと一致することまで
 * 確認してから遷移する。本人再認証とBOT接続の2つのCTAが同じOAuth/CSRF境界を共有し、
 * 片方だけ検証が弱くなる回帰を防ぐ（Issue #865）。
 */
export function parseTwitchAuthorizationResponse(body: unknown): TwitchAuthorizationResponse | null {
  if (typeof body !== 'object' || body === null) return null

  const { loginUrl, state } = body as Record<string, unknown>
  if (typeof loginUrl !== 'string' || typeof state !== 'string' || !STATE_PATTERN.test(state)) {
    return null
  }

  try {
    const url = new URL(loginUrl)
    // getAll: 重複したクエリ（?state=a&state=b等）はgetでは先頭しか見えず
    // 曖昧になるため、ちょうど1件だけであることも確認する。
    const stateParams = url.searchParams.getAll('state')
    const redirectUriParams = url.searchParams.getAll('redirect_uri')
    if (
      url.origin !== TWITCH_AUTHORIZATION_ORIGIN ||
      url.pathname !== TWITCH_AUTHORIZATION_PATH ||
      url.username !== '' ||
      url.password !== '' ||
      stateParams.length !== 1 ||
      stateParams[0] !== state ||
      redirectUriParams.length !== 1 ||
      !isSameOriginRedirectUri(redirectUriParams[0])
    ) {
      return null
    }
    return { loginUrl: url.href, state }
  } catch {
    return null
  }
}
