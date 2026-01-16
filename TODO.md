# TODO List

## Architecture & Design
- **React version mismatch** – Current `react@19` is not released at the time of Next.js 16. Upgrade to `react@18.2.2` and `react-dom@18.2.2` to match Next.js compatibility.
- **Missing runtime validation of env variables** – `validateEnvVars` only logs missing variables in development. Add a runtime error that halts the server if any required env var is missing (especially in production).
- **Centralized error handling** – API routes return plain JSON errors. Consider a shared error‑handling middleware to unify status codes and messages.
- **Supabase client re‑creation** – `getSupabaseAdmin` creates a new client on first call but never refreshes it. If service‑role key changes at runtime (unlikely), the cached client may become stale. Add a small TTL or a refresh mechanism.
- **Session cookie handling** – Session cookie name is hard‑coded. Extract into a constant and use the same constant across callback and other routes.
- **Type safety for API routes** – Export a type for the upload response and use it in the route and the client.
- **Public URL generation** – `getPublicUrl` can return `undefined` if the file is not found; guard against this.

## Testing & CI
- **Add unit tests** – Currently only e2e tests exist. Implement Jest/React Testing Library tests for components and utility functions.
- **Playwright config** – Create `playwright.config.ts` to define baseURL, timeout, and projects.
- **CI linting** – Add a GitHub Actions step to run `npm run lint` before tests.
- **Static type checking** – Add `npm run typecheck` using `tsc --noEmit` to catch type errors in CI.

## Documentation
- **README improvements** – Add screenshots, installation steps, and a FAQ section.
- **JSDoc comments** – Add JSDoc to exported functions for better IDE support.
- **Contribution guide** – Add a `CONTRIBUTING.md` file with guidelines.

## Miscellaneous
- **Environment variable loading** – Use `dotenv` in a central entry point to load `.env.local` during local dev.
- **`.env.local.example`** – Ensure it contains all required keys with placeholder values.
- **Prettier** – Add a `.prettierrc` file for consistent code formatting.
- **ESLint rule** – Disallow `console.log` in production with `no-console: ['error', { allow: ['warn', 'error'] }]`.
- **Security** – Set `SameSite=Lax` for authentication cookies and consider `Secure` flag based on environment.

---
Please review and prioritize these items as you see fit."
