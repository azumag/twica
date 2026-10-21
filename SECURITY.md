# Security Policy

## Vulnerability Management

This document tracks known security vulnerabilities and mitigation strategies in the twica application.

### Tracked Vulnerabilities

#### undici < 6.23.0 (GHSA-g9mf-h72j-4rw9) - RESOLVED

**Status:** Resolved (Migration to R2 complete)
**CVSS Score:** 3.7 (Low)
**CVE:** GHSA-g9mf-h72j-4rw9
**Previous Affected Package:** @vercel/blob

**Resolution:**
The application has migrated from Vercel Blob to Cloudflare R2 for storage.
- `@vercel/blob` has been removed from both dependencies and devDependencies
- The old Vercel Blob migration command is no longer part of the current npm scripts
- Production uploads and storage use Cloudflare R2

**Original Description:**
An unbounded decompression chain in HTTP responses on Node.js Fetch API via Content-Encoding leads to resource exhaustion.

**Current Mitigation:**
1. `@vercel/blob` is no longer present in the current package manifest
2. All new uploads go directly to Cloudflare R2
3. File upload validation and rate limiting remain in place

#### OBS Browser Source: reported chat-overlay attack path — not applicable to TwiCa

**Status:** TwiCa is not affected by the viewer-message HTML-injection path
described below (defense-in-depth added). The upstream browser-engine risk
remains for vulnerable Chromium builds.

**Upstream issue:** CVE-2024-7971 is a V8 type-confusion vulnerability in
Chromium versions before `128.0.6613.84` ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2024-7971)).
A published report chained viewer-controlled HTML in a chat overlay with this
vulnerability in OBS Browser Source to reach native code execution
([Orange Cyberdefense research](https://blog.scrt.ch/2026/09/22/how-one-twitch-chat-message-became-code-execution-on-a-streamers-pc/)).
For that reported Twitch-chat chain, viewer-controlled HTML injection was the
zero-click entry point. More generally, attacker-controlled content loaded
directly in a Browser Source or browser dock can reach the same browser-engine
attack surface.

OBS Studio 32.2.2's official build configuration selects CEF 6533
([OBS 32.2.2 build configuration](https://github.com/obsproject/obs-studio/blob/32.2.2/CMakePresets.json)).
The linked report measured its tested browser binary as Chromium 127.0.6533.120,
below the fixed version.

**Assessment of `/overlay/[streamerId]`:**
1. No HTML sinks: viewer-derived strings (Twitch user name) and card text are
   rendered only as React text nodes (auto-escaped). There are no
   `dangerouslySetInnerHTML` / `innerHTML` usages in `src/` or `workers/`.
   The viewer name is the EventSub `user_name` stored as-is (output encoding at
   render time, not input sanitization); a regression test in
   `tests/unit/components/overlay-page.test.tsx` renders an HTML payload as the
   viewer name / card text and asserts no element is created.
2. Viewer free-text (`user_input` of channel point redemptions) is never
   rendered and is stripped before being parked (`src/lib/maintenance/eventsub-park.ts`).
3. twica does not read Twitch chat; it only sends messages.
4. Card image / sound URLs are set by the streamer only (HTTPS, extension /
   storage-owner validation in `src/lib/validations.ts`, `src/lib/storage-utils.ts`).
5. A nonce + `'strict-dynamic'` CSP is applied to the overlay route
   (`src/lib/security-headers.ts`), so injected inline scripts would not run.

**Guardrail:** `eslint.config.mjs` rejects the TrustedHTML injection sinks
listed by MDN's Trusted Types API in `src/` and `workers/`, in both dot and
string-literal bracket notation: `innerHTML` / `outerHTML` / `srcdoc`
assignment, `insertAdjacentHTML`, `createContextualFragment`,
`setHTMLUnsafe`, `parseHTMLUnsafe`, `DOMParser#parseFromString`,
`execCommand` and `document.write` / `writeln`, plus React's
`dangerouslySetInnerHTML` and `<iframe srcDoc>`. The CI `lint` job
runs only on preview → main PRs, so `tests/unit/eslint-xss-sink-rule.test.ts`
also loads the real config in the unit `test` job to pin which patterns are
rejected and which (`textContent`, `WritableStream#write`) stay allowed.

**Recommendations for streamers (checked 2026-09-27):** Use only trusted
Browser Sources as a permanent trust-boundary rule, and keep OBS on the latest
official stable release. At this check, OBS Studio 32.2.2 is the
[latest official stable release](https://github.com/obsproject/obs-studio/releases)
and its build configuration selects CEF 6533. No official stable OBS release
with the CVE-fixed Chromium version was available at this check. For
CVE-2024-7971 specifically, verify the full bundled Chromium version is
`128.0.6613.84` or later; CEF 128 alone does not establish that this CVE is
fixed. Keep the Browser Source "Page permissions" at "No access to OBS" for
least privilege; this limits access to OBS APIs but does not patch Chromium or
enable its sandbox. twica's overlay does not use `window.obsstudio`.


#### Next.js / next-intl / transitive production dependencies (2026-10-21) - RESOLVED

**Status:** Resolved (manifest and lockfile updated to patched versions)
**Audit method:** `npm audit --package-lock-only --omit=dev --json` (2026-10-21)
**Result:** Critical 1 / High 5 / Moderate 1 (7 packages, multiple advisories per dependency)

**Updated dependencies:**

| Package | Previous | Updated | Advisory |
|---|---:|---:|---|
| next | 16.2.12 | 16.4.2 | GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4, GHSA-vcvr-r3jv-pc5j, GHSA-4jqv-mc3x-m676, GHSA-39w2-rjm5-chcv, GHSA-f87g-xv8r-7p7x, GHSA-mcj8-r9mp-w47p, GHSA-cjq9-62q9-8jv4 |
| next-intl | 4.7.0 | 4.14.9 | GHSA-8f24-v5vv-gm5j, GHSA-4c35-wcg5-mm9h |
| sharp | 0.34.5 | 0.35.5 | GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w |
| postcss | 8.4.31 | 8.5.23 | GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q, GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849 |
| nanoid | 3.3.11 | 3.3.20 | GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-xwg4-73v4-xw9w |
| source-map-js | 1.2.1 | 1.2.2 | GHSA-68fv-2mgg-jv7q |
| picomatch | 4.0.3 | 4.0.7 | GHSA-3v7f-55p6-f55p, GHSA-c2c7-rcm5-vvqj |

**Applicability assessment (production deps only):**

- Next.js Image Optimization SSRF (GHSA-cjq9-62q9-8jv4): remotePatterns allows any HTTPS host, but the majority of `<Image>` usages set `unoptimized`. The optimizer path is only reached for the few images without `unoptimized`. API-level validation (jpg/png extension) remains in place. remotePatterns minimization is deferred to a follow-up to avoid breaking external card image loading.
- Next.js AVIF RCE (GHSA-2xp9-vwfh-vxw4): sharp/libheif AVIF optimization path. Not confirmed reachable in OpenNext production deployment; sharp updated regardless.
- Next.js Windows RCE (GHSA-p293-qw3h-jr36): Windows-host condition; not applicable to Cloudflare Workers.
- Next.js ImageResponse (GHSA-vcvr-r3jv-pc5j): no `next/og` / `ImageResponse` usage found in src/.
- next-intl open redirect / prototype pollution (GHSA-8f24-v5vv-gm5j, GHSA-4c35-wcg5-mm9h): target middleware/precompile settings and attacker-controlled catalog keys not found in current configuration.
- Remaining transitive dev/test dependencies are tracked separately.

**Verification:**
- `npm audit --omit=dev`: 0 vulnerabilities
- `npm run typecheck`: pass
- `npm run test:unit`: 5671 passed
- `npm run build`: pass
- `npm run workers:build`: pass (OpenNext bundle generated)

### Security Best Practices

#### Session Management
- Sessions use `SameSite='lax'`（OAuth コールバックで Cookie を到達させるため。constants.ts 参照）
- CSRF tokens provide additional protection layer
- Sessions expire after 7 days
- Version field prevents concurrent modifications

#### Cookie Security
- All cookies use `httpOnly: true`
- All cookies use `secure: true` in production
- State cookie uses `SameSite='lax'` to allow OAuth callback

#### Input Validation
- All API inputs are validated
- Rate limiting is one layer of abuse mitigation; security-sensitive endpoints also rely on authentication, authorization, CSRF protection, input validation, and endpoint-specific controls as applicable
- CSRF protection on all state-changing requests

#### Rate Limiting
- Cloudflare Workers automatically use the `RATE_LIMIT_KV` binding when it is available
- Local development, tests, and environments where the binding cannot be resolved use the in-memory fallback
- Storage failures currently fail open, so strict abuse prevention must not rely on this rate limiter as the only control; distributed-backend and fail-open policy follow-up is tracked in Issue #728
- Per-endpoint rate limits
- Configurable windows and limits

## Security Resources

- [NIST Vulnerability Database](https://nvd.nist.gov/)
- [CVE Details](https://nvd.nist.gov/vuln/detail/CVE-2024-XXXX)
- [OWASP Top 10](https://owasp.org/www-project-top-ten)
- [Node.js Security](https://nodejs.org/en/security/)

## Reporting Security Issues

If you discover a security vulnerability in this application:

1. **Do not create a public GitHub issue**
2. Use GitHub Private Vulnerability Reporting: open the repository's
   **Security** tab and select **Report a vulnerability**
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if known)
   - Your contact information for follow-up

Private Vulnerability Reporting keeps the report confidential until it is
triaged, and GitHub can notify the maintainers directly.

## Security Response Timeline

We aim to respond to security reports within:
- 48 hours for critical vulnerabilities
- 72 hours for high severity
- 1 week for medium/low severity

## Dependency Auditing

Run `npm audit` regularly to check for known vulnerabilities:

```bash
npm audit
```

To automatically audit dependencies as part of CI/CD, consider adding to your workflow:

```yaml
- name: Security Audit
  run: npm audit
```

## Keeping Dependencies Updated

定期更新依存パッケージ:
- Run `npm update` regularly
- Review security advisories for all dependencies
- Prioritize security updates
- Test thoroughly after updates

## Last Updated

2026-10-21
