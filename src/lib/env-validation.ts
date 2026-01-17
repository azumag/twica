export interface EnvConfig {
  name: string
  required: boolean
  optional?: boolean
}

export const requiredEnvVars: EnvConfig[] = [
  { name: 'NEXT_PUBLIC_APP_URL', required: true },
  { name: 'NEXT_PUBLIC_TWITCH_CLIENT_ID', required: true },
  { name: 'TWITCH_CLIENT_ID', required: true },
  { name: 'TWITCH_CLIENT_SECRET', required: true },
  { name: 'TWITCH_EVENTSUB_SECRET', required: true },
  { name: 'NEXT_PUBLIC_SUPABASE_URL', required: true },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', required: true },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', required: true },
  { name: 'BLOB_READ_WRITE_TOKEN', required: true },
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
  const value = process.env[name]

  if (required && !value) {
    throw new Error(`Required environment variable ${name} is not set`)
  }

  return value
}

// Gacha cost validation
const gachaCost = parseInt(process.env.GACHA_COST || '100', 10)
if (isNaN(gachaCost) || gachaCost < 1 || gachaCost > 10000) {
  throw new Error('GACHA_COST must be a number between 1 and 10000')
}

const { valid, missing } = validateEnvVars()
if (!valid && process.env.NODE_ENV !== 'test' && !process.env.CI) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
}
