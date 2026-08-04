import { describe, expect, it } from 'vitest'
import { parseTwitchAuthorizationResponse } from '@/lib/twitch/authorization-response'

// Issue #865: reauth API・BOT接続APIの両方が共有するOAuth応答検証。
// origin/path/state不一致や壊れた応答をブラウザ遷移へ渡さないことを固定する。
describe('parseTwitchAuthorizationResponse', () => {
  const VALID_STATE = 'state-abc123'
  const SAME_ORIGIN_REDIRECT_URI = `${window.location.origin}/api/auth/twitch/callback`
  const VALID_LOGIN_URL =
    `https://id.twitch.tv/oauth2/authorize?client_id=abc&redirect_uri=${encodeURIComponent(SAME_ORIGIN_REDIRECT_URI)}&state=${VALID_STATE}`

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
    const shortState = 'short1'
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?state=${shortState}`,
      state: shortState,
    })

    expect(result).toBeNull()
  })

  it('URLに重複したstateクエリパラメータがあればnullを返す', () => {
    const result = parseTwitchAuthorizationResponse({
      loginUrl: `https://id.twitch.tv/oauth2/authorize?state=${VALID_STATE}&state=other-value`,
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
