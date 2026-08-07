# Security Policy

## Vulnerability Management

This document tracks known security vulnerabilities and mitigation strategies in the twica application.

### Current Vulnerabilities

#### undici < 6.23.0 (GHSA-g9mf-h72j-4rw9) - RESOLVED

**Status:** Resolved (Migration to R2 complete)
**CVSS Score:** 3.7 (Low)
**CVE:** GHSA-g9mf-h72j-4rw9
**Previous Affected Package:** @vercel/blob

**Resolution:**
The application has migrated from Vercel Blob to Cloudflare R2 for storage.
- @vercel/blob is now a devDependency only used for migration scripts
- Production builds do not include @vercel/blob
- The migration script (`npm run migrate:vercel-to-r2`) can be used to migrate existing files
- After migration is complete, @vercel/blob can be removed entirely

**Original Description:**
An unbounded decompression chain in HTTP responses on Node.js Fetch API via Content-Encoding leads to resource exhaustion.

**Current Mitigation:**
1. @vercel/blob is no longer used in production code
2. All new uploads go directly to Cloudflare R2
3. File upload validation and rate limiting remain in place

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
- Rate limiting prevents abuse
- CSRF protection on all state-changing requests
  （例外: `/api/twitch/eventsub/debug` の DELETE は #831 で追跡中）

#### Rate Limiting
- In-memory rate limiting for development
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
2. Email security reports to: [SECURITY_EMAIL]
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if known)
   - Your contact information for follow-up

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

2026-01-20
