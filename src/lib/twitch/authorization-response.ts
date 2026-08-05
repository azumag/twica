const TWITCH_AUTHORIZATION_ORIGIN = 'https://id.twitch.tv'
const TWITCH_AUTHORIZATION_PATH = '/oauth2/authorize'
// 環境ごとの期待client_id。NEXT_PUBLIC_プレフィックスのためビルド時にクライアント
// バンドルへリテラルとして埋め込まれ、preview/本番で値が異なっても各環境のビルドが
// 正しい期待値を持つ（Issue #869）。サーバー側のgetTwitchAuthUrl()と同じ変数から
// URLを生成するため、正当な応答は常にこの値と一致する。
const EXPECTED_CLIENT_ID = process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID
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
 * phishingを防げない。`client_id`は EXPECTED_CLIENT_ID で、`redirect_uri`の
 * origin一致はここでそれぞれ検証し、consent phishingの実効性を下げる
 * （Issue #869）。
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
 * stateとAPI応答のstateが一致すること、`redirect_uri`が自アプリのoriginと一致すること、
 * `client_id`が自アプリのもの（NEXT_PUBLIC_TWITCH_CLIENT_ID）と一致することまで
 * 確認してから遷移する。本人再認証とBOT接続の2つのCTAが同じOAuth/CSRF境界を共有し、
 * 片方だけ検証が弱くなる回帰を防ぐ（Issue #865）。
 *
 * client_idの照合はOAuth consent phishingへの最終防衛線のひとつ。同一originのJSON応答が
 * 侵害され、正規のTwitch認可URLのclient_idだけ攻撃者のものへ差し替えられた場合、
 * ユーザーが同意すれば認可コードが攻撃者アプリのredirect_uriへ流れる。期待値が未設定の
 * 場合は fail-closed でnullを返す（ビルド時にインライン化されるため実質常に設定済み）。
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
    const clientIdParams = url.searchParams.getAll('client_id')
    if (
      url.origin !== TWITCH_AUTHORIZATION_ORIGIN ||
      url.pathname !== TWITCH_AUTHORIZATION_PATH ||
      url.username !== '' ||
      url.password !== '' ||
      stateParams.length !== 1 ||
      stateParams[0] !== state ||
      redirectUriParams.length !== 1 ||
      !isSameOriginRedirectUri(redirectUriParams[0]) ||
      clientIdParams.length !== 1 ||
      clientIdParams[0] !== EXPECTED_CLIENT_ID
    ) {
      return null
    }
    return { loginUrl: url.href, state }
  } catch {
    return null
  }
}
