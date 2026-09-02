# Cloudflare Proxy Migration Policy

Next.js 16 reports the `middleware.ts` convention as deprecated and recommends
renaming it to `proxy.ts`. TwiCa intentionally keeps `src/middleware.ts` for
now because the current Cloudflare deployment path cannot build a Next.js Proxy.

## Current Decision

- Keep `src/middleware.ts` on `preview` while the current `@opennextjs/cloudflare`
  deployment path rejects Next.js Proxy / Node.js middleware.
- Do not add `src/proxy.ts` yet.
- Do not wait for `@opennextjs/cloudflare` itself to gain Proxy support. The
  upstream direction is to handle Node.js middleware through the newer
  `@opennextjs/adapters-api` architecture instead.
- Accept the Next.js deprecated convention warning as the smaller operational
  risk while Cloudflare builds still require Edge Middleware output.

## Verification

A direct migration from `src/middleware.ts` to `src/proxy.ts` removes the
Next.js warning, but `npm run workers:build` fails with:

```text
ERROR Node.js middleware is not currently supported. Consider switching to Edge Middleware.
```

Next.js 16 rejects forcing Proxy back to Edge runtime, so the blocker is in the
deployment compatibility layer rather than in TwiCa's middleware logic.

The incompatibility remains observable upstream as
[`opennextjs-cloudflare#1277`](https://github.com/opennextjs/opennextjs-cloudflare/issues/1277).

## Revisit Conditions

Revisit this decision when either of these is true:

- Migrating TwiCa to `@opennextjs/adapters-api` (or another Cloudflare deployment
  path with Next.js Proxy / Node.js middleware support) becomes practical and
  `npm run workers:build` can be verified on that path.
- TwiCa changes deployment architecture so request interception no longer needs
  to run in Cloudflare Workers middleware.
