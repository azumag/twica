# Cloudflare Proxy Migration Policy

Next.js 16 reports the `middleware.ts` convention as deprecated and recommends
renaming it to `proxy.ts`. TwiCa intentionally keeps `src/middleware.ts` for
now because the repository is pinned to `@opennextjs/cloudflare` 1.20.2, which
predates the adapter's Node.js middleware / `proxy.ts` support.

## Current Decision

- Keep `src/middleware.ts` on `preview` while TwiCa remains on
  `@opennextjs/cloudflare` 1.20.2 and the `proxy.ts` path has not been verified
  with TwiCa's existing middleware behavior.
- Do not add `src/proxy.ts` yet.
- Upstream support is no longer only a future Adapters API direction:
  `opennextjs/opennextjs-cloudflare#1309` added experimental Node.js middleware
  (`proxy.ts`) support directly to `@opennextjs/cloudflare`, and it shipped in
  1.20.3. The support requires the `nodejs_compat` compatibility flag.
- Accept the Next.js deprecated convention warning as the smaller operational
  risk until the dependency is upgraded and `npm run workers:build` is verified
  on TwiCa's actual middleware path.

## Verification

With TwiCa's currently pinned adapter version, a direct migration from
`src/middleware.ts` to `src/proxy.ts` removes the Next.js warning, but the
previous verification failed `npm run workers:build` with:

```text
ERROR Node.js middleware is not currently supported. Consider switching to Edge Middleware.
```

The upstream blocker tracked as
[`opennextjs-cloudflare#1277`](https://github.com/opennextjs/opennextjs-cloudflare/issues/1277)
was closed on 2026-08-25 when
[`opennextjs-cloudflare#1309`](https://github.com/opennextjs/opennextjs-cloudflare/pull/1309)
merged. `@opennextjs/cloudflare` 1.20.3, published on 2026-08-26, includes that
experimental `proxy.ts` support.

Upstream status last checked: **2026-09-05**. TwiCa is still pinned to
`@opennextjs/cloudflare` 1.20.2, so the upstream fix has not yet changed the
repository's verified deployment contract.

## Revisit Conditions

Revisit this decision when either of these is true:

- TwiCa upgrades to an `@opennextjs/cloudflare` release containing #1309
  (1.20.3 or newer) and `npm run workers:build` succeeds with `src/proxy.ts`
  while the existing session refresh, protected-route, and middleware contract
  tests remain green.
- TwiCa changes deployment architecture so request interception no longer needs
  to run in Cloudflare Workers middleware.
