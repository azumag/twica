export interface EnvConfig {
  name: string
  required: boolean
  optional?: boolean
}

export const requiredEnvVars: EnvConfig[] = [
  { name: 'NEXT_PUBLIC_APP_URL', required: true },
  { name: 'NEXT_PUBLIC_TWITCH_CLIENT_ID', required: true },
  { name: 'TWITCH_CLIENT_SECRET', required: true },
  { name: 'TWITCH_EVENTSUB_SECRET', required: true },
  { name: 'NEXT_PUBLIC_SUPABASE_URL', required: true },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', required: true },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', required: true },
  // BLOB_READ_WRITE_TOKEN は Vercel Blob 用で、Cloudflare R2 ネイティブバインディング移行後は不要
  { name: 'CSRF_TOKEN_SALT', required: true },
]

export function validateEnvVars(): { valid: boolean; missing: string[] } {
  const missing: string[] = []

  for (const config of requiredEnvVars) {
    if (config.required && !process.env[config.name]) {
      missing.push(config.name)
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  }
}

export function getEnvVar(name: string, required: boolean = false): string | undefined {
  // 環境変数に改行や空白が混入する場合があるため（Cloudflareダッシュボードでのペースト時など）
  // 前後の空白・改行を除去する
  const value = process.env[name]?.trim()

  if (required && !value) {
    throw new Error(`Required environment variable ${name} is not set`)
  }

  return value
}

export function validateCSRFTokenSalt(): { valid: boolean; error?: string } {
  const salt = process.env.CSRF_TOKEN_SALT

  if (!salt) {
    return { valid: false, error: 'CSRF_TOKEN_SALT is not set' }
  }

  if (salt.length < 32) {
    return { 
      valid: false, 
      error: 'CSRF_TOKEN_SALT must be at least 32 characters for cryptographic security' 
    }
  }

  return { valid: true }
}

// ビルドフェーズ (next build) ではランタイム専用の環境変数がまだ存在しないため、
// モジュール読み込み時の検証をスキップする。
// 秘密鍵は Cloudflare secrets で管理し、ランタイムに populateProcessEnv で注入される。
const isBuilding = process.env.NEXT_PHASE === 'phase-production-build'

if (!isBuilding && process.env.NODE_ENV !== 'test' && !process.env.CI) {
  // Gacha cost validation
  const gachaCost = parseInt(process.env.GACHA_COST || '100', 10)
  if (isNaN(gachaCost) || gachaCost < 1 || gachaCost > 10000) {
    throw new Error('GACHA_COST must be a number between 1 and 10000')
  }

  // CSRF token salt validation
  const csrfSaltValidation = validateCSRFTokenSalt()
  if (!csrfSaltValidation.valid) {
    throw new Error(`CSRF token salt validation failed: ${csrfSaltValidation.error}`)
  }

  const { valid, missing } = validateEnvVars()
  if (!valid) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }
}
