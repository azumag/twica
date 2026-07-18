import { describe, expect, it } from 'vitest'
import {
  parseArgs,
  resolveBaseUrl,
  substituteDynamicSegments,
  buildProbeUrl,
  flattenChecks,
  isMaintenanceErrorCode,
  evaluateBlockCheck,
  evaluateRedirectCheck,
  evaluateExemptCheck,
  evaluateCheckResult,
  looksLikeMaintenanceModeOff,
  allNetworkErrors,
} from '../../scripts/probe-maintenance-write-surfaces.js'

describe('parseArgs', () => {
  it('--url= 形式のフラグからURLを取り出す', () => {
    expect(parseArgs(['node', 'script.js', '--url=https://example.com'])).toEqual({
      help: false,
      url: 'https://example.com',
    })
  })

  it('位置引数からURLを取り出す', () => {
    expect(parseArgs(['node', 'script.js', 'https://example.com'])).toEqual({
      help: false,
      url: 'https://example.com',
    })
  })

  it('--url= フラグと位置引数が両方ある場合はフラグを優先する', () => {
    expect(
      parseArgs(['node', 'script.js', 'https://positional.example.com', '--url=https://flag.example.com'])
    ).toEqual({ help: false, url: 'https://flag.example.com' })
  })

  it('--help を検出する', () => {
    expect(parseArgs(['node', 'script.js', '--help'])).toEqual({ help: true, url: undefined })
  })

  it('-h を検出する', () => {
    expect(parseArgs(['node', 'script.js', '-h'])).toEqual({ help: true, url: undefined })
  })

  it('引数が無い場合は help:false, url:undefined', () => {
    expect(parseArgs(['node', 'script.js'])).toEqual({ help: false, url: undefined })
  })
})

describe('resolveBaseUrl', () => {
  it('--help があれば { help: true } を返す', () => {
    expect(resolveBaseUrl(['node', 'script.js', '--help'], {})).toEqual({ help: true })
  })

  it('URLが指定されていなければエラーを返す', () => {
    const result = resolveBaseUrl(['node', 'script.js'], {})
    expect('error' in result).toBe(true)
  })

  it('CLI引数のURLを採用し、末尾スラッシュを除去する', () => {
    const result = resolveBaseUrl(['node', 'script.js', '--url=https://example.com/'], {})
    expect(result).toEqual({ baseUrl: 'https://example.com' })
  })

  it('CLI引数が無い場合は環境変数のURLを採用する', () => {
    const result = resolveBaseUrl(['node', 'script.js'], {
      MAINTENANCE_PROBE_BASE_URL: 'https://env.example.com',
    })
    expect(result).toEqual({ baseUrl: 'https://env.example.com' })
  })

  it('CLI引数が環境変数より優先される', () => {
    const result = resolveBaseUrl(['node', 'script.js', '--url=https://cli.example.com'], {
      MAINTENANCE_PROBE_BASE_URL: 'https://env.example.com',
    })
    expect(result).toEqual({ baseUrl: 'https://cli.example.com' })
  })

  it('http:// または https:// で始まらないURLはエラーを返す', () => {
    const result = resolveBaseUrl(['node', 'script.js', '--url=ftp://example.com'], {})
    expect('error' in result).toBe(true)
  })
})

describe('substituteDynamicSegments', () => {
  it('単一の動的セグメントをプレースホルダに置換する', () => {
    expect(substituteDynamicSegments('/api/cards/[id]')).toBe('/api/cards/probe-dummy-id')
  })

  it('複数の動的セグメントをそれぞれ置換する', () => {
    expect(substituteDynamicSegments('/api/support-inquiries/[id]/messages/[messageId]')).toBe(
      '/api/support-inquiries/probe-dummy-id/messages/probe-dummy-id'
    )
  })

  it('動的セグメントが無いpathはそのまま返す', () => {
    expect(substituteDynamicSegments('/api/cards')).toBe('/api/cards')
  })
})

describe('buildProbeUrl', () => {
  it('baseUrlとpathを連結する', () => {
    expect(buildProbeUrl('https://example.com', '/api/cards')).toBe('https://example.com/api/cards')
  })
})

describe('flattenChecks', () => {
  it('1エントリ1methodをそのまま1チェックに変換する', () => {
    const inventory = [{ path: '/api/cards', methods: ['POST'], maintenanceBehavior: 'block', category: 'cards' }]
    expect(flattenChecks(inventory)).toEqual([
      {
        originalPath: '/api/cards',
        path: '/api/cards',
        method: 'POST',
        behavior: 'block',
        category: 'cards',
      },
    ])
  })

  it('複数methodsを持つエントリをmethodごとに分割する', () => {
    const inventory = [
      {
        path: '/api/streamer/additional-rewards',
        methods: ['PUT', 'DELETE'],
        maintenanceBehavior: 'block',
        category: 'streamer',
      },
    ]
    const result = flattenChecks(inventory)
    expect(result).toHaveLength(2)
    expect(result.map((c) => c.method)).toEqual(['PUT', 'DELETE'])
    expect(result.every((c) => c.path === '/api/streamer/additional-rewards')).toBe(true)
  })

  it('動的セグメントを含むpathを置換した上でoriginalPathは元のまま保持する', () => {
    const inventory = [
      { path: '/api/cards/[id]', methods: ['DELETE'], maintenanceBehavior: 'block', category: 'cards' },
    ]
    const [check] = flattenChecks(inventory)
    expect(check.originalPath).toBe('/api/cards/[id]')
    expect(check.path).toBe('/api/cards/probe-dummy-id')
  })
})

describe('isMaintenanceErrorCode', () => {
  it('"maintenance_" prefixの文字列はtrue', () => {
    expect(isMaintenanceErrorCode('maintenance_read_only')).toBe(true)
  })

  it('prefixが一致しない文字列はfalse', () => {
    expect(isMaintenanceErrorCode('some_other_error')).toBe(false)
  })

  it('文字列以外の値 (null/undefined/数値) はfalse', () => {
    expect(isMaintenanceErrorCode(null)).toBe(false)
    expect(isMaintenanceErrorCode(undefined)).toBe(false)
    expect(isMaintenanceErrorCode(123)).toBe(false)
  })
})

describe('evaluateBlockCheck', () => {
  it('503 + maintenance_prefixのcodeでpass', () => {
    const result = evaluateBlockCheck(503, { error: { code: 'maintenance_read_only' } })
    expect(result.ok).toBe(true)
  })

  it('503以外はfail', () => {
    const result = evaluateBlockCheck(403, { error: { code: 'maintenance_read_only' } })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('503を期待しましたが')
  })

  it('503だがcodeがmaintenance_prefixでない場合はfail', () => {
    const result = evaluateBlockCheck(503, { error: { code: 'some_other_error' } })
    expect(result.ok).toBe(false)
  })

  it('503だがerrorオブジェクト自体が無い場合はfail', () => {
    const result = evaluateBlockCheck(503, {})
    expect(result.ok).toBe(false)
  })

  it('statusがnull (ネットワーク応答なし相当) の場合はfail', () => {
    const result = evaluateBlockCheck(null, null)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('(応答なし)')
  })
})

describe('evaluateRedirectCheck', () => {
  it('302 + Locationに"/?maintenance=1"を含めばpass', () => {
    const result = evaluateRedirectCheck(302, 'https://example.com/?maintenance=1')
    expect(result.ok).toBe(true)
  })

  it('302以外はfail', () => {
    const result = evaluateRedirectCheck(200, 'https://example.com/?maintenance=1')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('302を期待しましたが')
  })

  it('302だがLocationに"/?maintenance=1"を含まない場合はfail', () => {
    const result = evaluateRedirectCheck(302, 'https://example.com/other')
    expect(result.ok).toBe(false)
  })

  it('302だがLocationヘッダーが無い場合はfail', () => {
    const result = evaluateRedirectCheck(302, null)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('(なし)')
  })
})

describe('evaluateExemptCheck', () => {
  it('503の場合はfail', () => {
    const result = evaluateExemptCheck(503)
    expect(result.ok).toBe(false)
  })

  it('503以外 (200) はpass', () => {
    const result = evaluateExemptCheck(200)
    expect(result.ok).toBe(true)
  })

  it('503以外 (403, CSRF失敗等) もpass', () => {
    const result = evaluateExemptCheck(403)
    expect(result.ok).toBe(true)
  })

  it('statusがnullでもpass (503ではないため)', () => {
    const result = evaluateExemptCheck(null)
    expect(result.ok).toBe(true)
  })
})

describe('evaluateCheckResult', () => {
  it('networkErrorがあればbehaviorに関わらずfail', () => {
    const result = evaluateCheckResult({
      behavior: 'block',
      status: null,
      jsonBody: null,
      locationHeader: null,
      networkError: 'ECONNREFUSED',
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('ネットワークエラー')
  })

  it('behavior=blockはevaluateBlockCheckにディスパッチする', () => {
    const result = evaluateCheckResult({
      behavior: 'block',
      status: 503,
      jsonBody: { error: { code: 'maintenance_read_only' } },
      locationHeader: null,
      networkError: null,
    })
    expect(result.ok).toBe(true)
  })

  it('behavior=redirectはevaluateRedirectCheckにディスパッチする', () => {
    const result = evaluateCheckResult({
      behavior: 'redirect',
      status: 302,
      jsonBody: null,
      locationHeader: 'https://example.com/?maintenance=1',
      networkError: null,
    })
    expect(result.ok).toBe(true)
  })

  it('behavior=allowはevaluateExemptCheckにディスパッチする', () => {
    const result = evaluateCheckResult({
      behavior: 'allow',
      status: 403,
      jsonBody: null,
      locationHeader: null,
      networkError: null,
    })
    expect(result.ok).toBe(true)
  })

  it('behavior=queue-during-maintenanceはevaluateExemptCheckにディスパッチする', () => {
    const result = evaluateCheckResult({
      behavior: 'queue-during-maintenance',
      status: 403,
      jsonBody: null,
      locationHeader: null,
      networkError: null,
    })
    expect(result.ok).toBe(true)
  })

  it('未知のbehaviorはfail', () => {
    const result = evaluateCheckResult({
      behavior: 'typo-value',
      status: 200,
      jsonBody: null,
      locationHeader: null,
      networkError: null,
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('未知の maintenanceBehavior')
  })
})

describe('looksLikeMaintenanceModeOff', () => {
  it('空配列はfalse', () => {
    expect(looksLikeMaintenanceModeOff([])).toBe(false)
  })

  it('block系エントリが全件503以外の場合はtrue (mode=offの兆候)', () => {
    expect(looksLikeMaintenanceModeOff([{ status: 403 }, { status: 401 }])).toBe(true)
  })

  it('block系エントリが一部だけ503以外の場合はfalse (個別routeのregressionを誤検出しない)', () => {
    expect(looksLikeMaintenanceModeOff([{ status: 503 }, { status: 403 }])).toBe(false)
  })

  it('block系エントリが全件503の場合はfalse (正常系)', () => {
    expect(looksLikeMaintenanceModeOff([{ status: 503 }, { status: 503 }])).toBe(false)
  })
})

describe('allNetworkErrors', () => {
  it('空配列はfalse', () => {
    expect(allNetworkErrors([])).toBe(false)
  })

  it('全件がネットワークエラーの場合はtrue', () => {
    expect(allNetworkErrors([{ networkError: 'ECONNREFUSED' }, { networkError: 'timeout' }])).toBe(true)
  })

  it('一部だけネットワークエラーの場合はfalse', () => {
    expect(allNetworkErrors([{ networkError: 'ECONNREFUSED' }, { networkError: null }])).toBe(false)
  })

  it('全件ネットワークエラー無しの場合はfalse', () => {
    expect(allNetworkErrors([{ networkError: null }, { networkError: null }])).toBe(false)
  })
})
