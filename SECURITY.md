# Security Policy

## Vulnerability Management

This document tracks known security vulnerabilities and mitigation strategies in the twica application.

### Current Vulnerabilities

#### undici < 6.23.0 (GHSA-g9mf-h72j-4rw9)

**Status:** Open  
**CVSS Score:** 3.7 (Low)  
**CVE:** GHSA-g9mf-h72j-4rw9  
**Affected Package:** @vercel/blob >= 0.0.3  
**Direct Dependency:** undici < 6.23.0  
**Current Version:** @vercel/blob@2.0.0 (undici@5.29.0)

**Description:**
An unbounded decompression chain in HTTP responses on Node.js Fetch API via Content-Encoding leads to resource exhaustion.

**Attack Vector:**
An attacker can send specially crafted HTTP responses with excessive Content-Encoding headers causing undici's decompressor to consume unbounded memory and CPU, potentially leading to:
- Denial of Service (DoS) attacks
- Resource exhaustion
- Potential server crashes

**Impact on Application:**
The @vercel/blob package is used for file upload functionality and blob storage. An attacker could exploit this vulnerability by:
- Uploading specially crafted files
- Triggering requests through any HTTP operations using undici (used internally by Next.js fetch)

**Mitigation Strategies:**
1. **Request timeout and size limits:** Already implemented for file uploads
   - File size validation in upload API
   - Rate limiting on upload endpoint

2. **Resource monitoring:** Monitor server resources for abnormal patterns

3. **Network request limits:** Rate limiting is implemented across all API endpoints

**Remediation Timeline:**
- Monitor @vercel/blob releases for updates
- Update to latest version when undici >= 6.23.0 is available
- Run `npm audit fix --force` when fix is available

**Testing Required After Fix:**
1. Run `npm audit` to verify no vulnerabilities remain
2. Test file upload functionality thoroughly
3. Verify blob storage operations work correctly
4. Monitor for any breaking changes

### Security Best Practices

#### Session Management
- Sessions use `SameSite='strict'` for CSRF protection
- CSRF tokens provide additional protection layer
- Sessions expire after 7 days
- Version field prevents concurrent modifications

#### Cookie Security
- All cookies use `httpOnly: true`
- All cookies use `secure: true` in production
- State cookie uses `SameSite='lax' to allow OAuth callback

#### Input Validation
- All API inputs are validated
- Rate limiting prevents abuse
- CSRF protection on all state-changing requests

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
