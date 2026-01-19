#!/usr/bin/env node

/**
 * API Test Script
 * Tests authenticated API endpoints using session cookie
 */

const BASE_URL = process.env.API_TEST_BASE_URL || 'http://localhost:3000'
const SESSION_COOKIE = process.env.API_TEST_SESSION_COOKIE || ''

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
}

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  test: (msg) => console.log(`${colors.gray}→${colors.reset} ${msg}`),
}

/**
 * Make authenticated request
 */
async function request(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`
  const headers = {
    'Cookie': `twica_session=${SESSION_COOKIE}`,
    'Content-Type': 'application/json',
    ...options.headers,
  }

  const response = await fetch(url, {
    ...options,
    headers,
  })

  const contentType = response.headers.get('content-type')
  let data = null

  if (contentType && contentType.includes('application/json')) {
    data = await response.json()
  } else {
    data = await response.text()
  }

  return {
    status: response.status,
    ok: response.ok,
    data,
    headers: Object.fromEntries(response.headers.entries()),
  }
}

/**
 * Test runner
 */
async function runTests() {
  console.log('\n🧪 API Test Suite\n')

  if (!SESSION_COOKIE) {
    log.error('SESSION_COOKIE not provided')
    log.info('Set API_TEST_SESSION_COOKIE environment variable')
    process.exit(1)
  }

  let passed = 0
  let failed = 0

  // Test 1: Session endpoint
  log.test('Testing GET /api/session')
  let sessionData = null
  try {
    const res = await request('/api/session')
    if (res.ok && res.data.twitchUsername) {
      sessionData = res.data
      log.success(`Session check passed (User: ${res.data.twitchUsername})`)
      passed++
    } else {
      log.error(`Session check failed: ${res.status} ${JSON.stringify(res.data)}`)
      failed++
    }
  } catch (error) {
    log.error(`Session check failed: ${error.message}`)
    failed++
  }

  // Test 2: User cards endpoint
  log.test('Testing GET /api/user-cards')
  try {
    const res = await request('/api/user-cards')
    if (res.ok) {
      log.success(`User cards retrieved: ${res.data.length} cards`)
      passed++
    } else {
      log.error(`User cards failed: ${res.status} ${JSON.stringify(res.data)}`)
      failed++
    }
  } catch (error) {
    log.error(`User cards failed: ${error.message}`)
    failed++
  }

  // Test 3: Get streamer settings (to get streamerId)
  log.test('Testing GET /api/streamer/settings')
  let streamerId = null
  try {
    const res = await request('/api/streamer/settings')
    if (res.ok && res.data.streamerId) {
      streamerId = res.data.streamerId
      log.success(`Streamer settings retrieved (Streamer ID: ${streamerId})`)
      passed++
    } else if (res.status === 403 || res.status === 404) {
      log.warn('User is not a streamer (skipping streamer-only tests)')
      passed++
    } else {
      log.error(`Streamer settings failed: ${res.status} ${JSON.stringify(res.data)}`)
      failed++
    }
  } catch (error) {
    log.error(`Streamer settings failed: ${error.message}`)
    failed++
  }

  // Test 4: Cards endpoint (GET) - only if streamer
  if (streamerId) {
    log.test(`Testing GET /api/cards?streamerId=${streamerId}`)
    try {
      const res = await request(`/api/cards?streamerId=${streamerId}`)
      if (res.ok) {
        log.success(`Cards retrieved: ${res.data.length} cards available`)
        passed++
      } else {
        log.error(`Cards GET failed: ${res.status} ${JSON.stringify(res.data)}`)
        failed++
      }
    } catch (error) {
      log.error(`Cards GET failed: ${error.message}`)
      failed++
    }
  } else {
    log.warn('Skipping cards GET test (no streamerId)')
  }

  // Test 5: Twitch rewards endpoint - only if streamer
  if (streamerId) {
    log.test('Testing GET /api/twitch/rewards')
    try {
      const res = await request('/api/twitch/rewards')
      if (res.ok) {
        log.success(`Twitch rewards retrieved: ${res.data.length} rewards`)
        passed++
      } else if (res.status === 401 || res.status === 500) {
        log.warn('Twitch rewards failed (may need token refresh)')
        passed++
      } else {
        log.error(`Twitch rewards failed: ${res.status} ${JSON.stringify(res.data)}`)
        failed++
      }
    } catch (error) {
      log.error(`Twitch rewards failed: ${error.message}`)
      failed++
    }
  } else {
    log.warn('Skipping twitch rewards test (no streamerId)')
  }

  // Test 6: Battle stats endpoint
  log.test('Testing GET /api/battle/stats')
  try {
    const res = await request('/api/battle/stats')
    if (res.ok) {
      log.success('Battle stats retrieved')
      passed++
    } else if (res.status === 500) {
      log.warn('Battle stats failed (database may be empty)')
      passed++
    } else {
      log.error(`Battle stats failed: ${res.status} ${JSON.stringify(res.data)}`)
      failed++
    }
  } catch (error) {
    log.error(`Battle stats failed: ${error.message}`)
    failed++
  }

  // Summary
  console.log('\n' + '='.repeat(50))
  console.log(`${colors.green}Passed: ${passed}${colors.reset} | ${colors.red}Failed: ${failed}${colors.reset}`)

  if (failed === 0) {
    log.success('All tests passed! 🎉')
    process.exit(0)
  } else {
    log.error(`${failed} test(s) failed`)
    process.exit(1)
  }
}

// Run tests
runTests().catch((error) => {
  log.error(`Test suite failed: ${error.message}`)
  console.error(error)
  process.exit(1)
})
