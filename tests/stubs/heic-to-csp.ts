/**
 * Vite must resolve a concrete file before Vitest can apply the factory mock
 * in `heic-converter.test.ts`. The implementation must never run in that
 * unit test; throwing here makes an accidentally unmocked import fail loudly
 * instead of performing a real HEIC conversion in the test process.
 */
export function heicTo(): never {
  throw new Error('The heic-to/csp test stub must be mocked by the unit test.')
}
