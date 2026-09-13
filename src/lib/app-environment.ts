export type AppEnvironment = 'production' | 'preview'

/**
 * TwiCa の論理環境名を既存契約どおり解決する。
 * `NEXT_PUBLIC_APP_URL` に `preview` を含む場合だけ preview、それ以外
 * （未設定を含む）は production とする。
 */
export function resolveAppEnvironment(
  appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL,
): AppEnvironment {
  return (appUrl || '').includes('preview') ? 'preview' : 'production'
}
