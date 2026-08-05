import { describe, expect, it } from 'vitest'
import { parseTwitchAuthorizationResponse } from '@/lib/twitch/authorization-response'

// Issue #865: reauth API・BOT接続APIの両方が共有するOAuth応答検証。
// origin/path/state不一致や壊れた応答をブラウザ遷移へ渡さないことを固定する。
describe('parseTwitchAuthorizationResponse', () => {
  const VALID_STATE = 'state-abc123'
  const SAME_ORIGIN_REDIRECT_URI = `${window.location.origin}/api/auth/twitch/callback`
  // tests/setup.ts が NEXT_PUBLIC_TWITCH_CLIENT_ID='test-client-id' を設定する。
  // 有効なclient_idは実装の EXPECTED_CLIENT_ID（＝このenv var）と一致させる。
  const VALID_CLIENT_ID = process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!
  const VALID_LOGIN_URL =
    `https://id.twitch.tv/oauth2/authorize?client_id=${VALID_CLIENT_ID}&redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&state=${VALID_STATE}`

  it('Twitch公式の認可URLかつstateが一致すれば正規化して返す', () => {
    const result = parseTwitchAuthorizationResponse({ loginUrl: VALID_LOGIN_URL, state: VALID_STATE })

    expect(result).toEqual({ loginUrl: VALID_LOGIN_URL, state: VALID_STATE })
  })

  it('redirect_uriが自アプリと異なるoriginならnullを返す（Issue #869: consent phishing対策）', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?redirect_uri=${encodeURIComponent('https://evil.example.com/callback')}&state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('redirect_uriが欠落していればnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('URLに重複したredirect_uriクエリパラメータがあればnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&redirect_uri=${encodeURIComponent('https://evil.example.com/callback')}&state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('redirect_uriが不正なURL文字列ならnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?redirect_uri=not-a-url&state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('originがTwitch公式と異なればnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://evil.example.com/oauth2/authorize?state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('pathがoauth2/authorize以外ならnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/token?state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('URL内のstateとbodyのstateが不一致ならnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?state=different-state`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('stateに許可されない文字（cookie属性インジェクションを狙った値）が含まれていればnullを返す', () => {
    const maliciousState = 'abc; Domain=evil.com; Path=/'
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?state=${encodeURIComponent(maliciousState)}`,
      state: maliciousState,
    })

    expect(result).toBeNull()
  })

  it('stateが8文字未満ならnullを返す', () => {
    // redirect_uriを含めない場合、その欠落だけでもnullになりstate長の検証を
    // 実質テストできなくなる（vacuous test）ため、他はすべて有効な形にする。
    const shortState = 'short1'
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?client_id=${VALID_CLIENT_ID}&redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&state=${shortState}`,
      state: shortState,
    })

    expect(result).toBeNull()
  })

  it('stateがちょうど8文字なら正規化して返す（下限の境界値）', () => {
    const boundaryState = 'a'.repeat(8)
    const loginUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${VALID_CLIENT_ID}&redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&state=${boundaryState}`
    const result = parseTwitchAuthorizationResponse({ loginUrl, state: boundaryState })

    expect(result).toEqual({ loginUrl, state: boundaryState })
  })

  it('stateが256文字を超えるならnullを返す', () => {
    // redirect_uriを含めない場合、その欠落だけでもnullになりstate長の検証を
    // 実質テストできなくなる（vacuous test）ため、他はすべて有効な形にする。
    const longState = 'a'.repeat(257)
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?client_id=${VALID_CLIENT_ID}&redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&state=${longState}`,
      state: longState,
    })

    expect(result).toBeNull()
  })

  it('stateがちょうど256文字なら正規化して返す（上限の境界値）', () => {
    const boundaryState = 'a'.repeat(256)
    const loginUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${VALID_CLIENT_ID}&redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&state=${boundaryState}`
    const result = parseTwitchAuthorizationResponse({ loginUrl, state: boundaryState })

    expect(result).toEqual({ loginUrl, state: boundaryState })
  })

  it('URLに重複したstateクエリパラメータがあればnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?state=${VALID_STATE}&state=other-value`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('client_idが自アプリのものと異なればnullを返す（Issue #869: consent phishing対策）', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?client_id=attacker-client-id&redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('client_idが欠落していればnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('URLに重複したclient_idクエリパラメータがあればnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?client_id=${VALID_CLIENT_ID}&client_id=${VALID_CLIENT_ID}&redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('client_idとredirect_uriの両方が攻撃者のものならnullを返す（consent phishingの完全なケース）', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?client_id=attacker-client-id&redirect_uri=${encodeURIComponent('https://evil.example.com/callback')}&state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('URLにusername/passwordが埋め込まれていればnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://attacker:pw@id.twitch.tv/oauth2/authorize?state=${VALID_STATE}`,
      state: VALID_STATE,
    })

    expect(result).toBeNull()
  })

  it('loginUrlが不正なURL文字列ならnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({ loginUrl: 'not a url', state: VALID_STATE })

    expect(result).toBeNull()
  })

  it.each([
    ['loginUrlが欠落', { state: VALID_STATE }],
    ['stateが欠落', { loginUrl: VALID_LOGIN_URL }],
    ['stateが空文字', { loginUrl: VALID_LOGIN_URL, state: '' }],
    ['bodyがnull', null],
    ['bodyが文字列', 'unexpected'],
  ])('%s の場合はnullを返す', (_label, body) => {
    expect(parseTwitchAuthorizationResponse(body)).toBeNull()
  })
})
