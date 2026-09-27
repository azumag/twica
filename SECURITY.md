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

#### OBS Browser Source: chat-overlay XSS → CVE-2024-7971 (OBS Studio ≤ 32.2.2) - NOT AFFECTED

**Status:** Not affected (defense-in-depth added)
**Upstream issue:** Vulnerable third-party chat overlays inserted viewer messages
as HTML. In OBS Browser Source (Chromium sandbox disabled, bundled CEF with
V8 type confusion CVE-2024-7971), a malicious Twitch chat message could reach
native code execution on the streamer's PC.

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

**Guardrail:** `eslint.config.mjs` rejects `dangerouslySetInnerHTML`,
`innerHTML` / `outerHTML` assignment, `insertAdjacentHTML`,
`createContextualFragment` and `document.write` / `writeln` in `src/` and
`workers/`, in both dot and string-literal bracket notation. The CI `lint` job
runs only on preview → main PRs, so `tests/unit/eslint-xss-sink-rule.test.ts`
also loads the real config in the unit `test` job to pin which patterns are
rejected and which (`textContent`, `WritableStream#write`) stay allowed.

**Recommendation for streamers:** The root cause is in OBS itself. Update OBS
Studio to a release that bundles CEF 128 or later, and do not add untrusted
Browser Sources. twica's overlay does not use the `window.obsstudio` API, so
the Browser Source "Page permissions" can stay at "No access to OBS".

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

2026-09-22
