// Vitest-only resolution target for Next.js's side-effect-only `server-only`
// marker. Production never resolves this file; vitest.config.ts scopes the
// alias to tests, preserving Next.js's server/client boundary enforcement.
export {}
