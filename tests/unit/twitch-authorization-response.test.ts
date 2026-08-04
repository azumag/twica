import { describe, expect, it } from 'vitest'
import { parseTwitchAuthorizationResponse } from '@/lib/twitch/authorization-response'

// Issue #865: reauth API・BOT接続APIの両方が共有するOAuth応答検証。
// origin/path/state不一致や壊れた応答をブラウザ遷移へ渡さないことを固定する。
describe('parseTwitchAuthorizationResponse', () => {
  const VALID_STATE = 'state-abc123'
  const VALID_LOGIN_URL = `https://id.twitch.tv/oauth2/authorize?client_id=abc&state=${VALID_STATE}`

  it('Twitch公式の認可URLかつstateが一致すれば正規化して返す', () => {
    const result = parseTwitchAuthorizationResponse({ loginUrl: VALID_LOGIN_URL, state: VALID_STATE })

    expect(result).toEqual({ loginUrl: VALID_LOGIN_URL, state: VALID_STATE })
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
