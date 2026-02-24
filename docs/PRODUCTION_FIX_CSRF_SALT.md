# Production Environment Configuration Issue Resolution

## Issue #91: CSRF_TOKEN_SALT Not Set

### Problem
Production environment is crashing with error:
```
Error: CSRF token salt validation failed: CSRF_TOKEN_SALT is not set
```

### Root Cause
The `CSRF_TOKEN_SALT` environment variable is not configured in the Vercel production environment. This variable is required for CSRF protection and must be at least 32 characters long.

### Solution

#### Step 1: Generate a Secure CSRF Token Salt

Generate a cryptographically secure random string (minimum 32 characters):

```bash
# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Using OpenSSL
openssl rand -hex 32

# Example output (DO NOT use this - generate your own):
a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2
```

#### Step 2: Add to Vercel Environment Variables

1. Go to Vercel Dashboard: https://vercel.com/dashboard
2. Select the `twica` project
3. Go to **Settings** → **Environment Variables**
4. Add the following variable:
   - **Name:** `CSRF_TOKEN_SALT`
   - **Value:** [Your generated secure salt]
   - **Environments:** Select **Production** (and optionally Development, Preview)
5. Click **Save**

#### Step 3: Redeploy the Application

After adding the environment variable:
1. Go to **Deployments** in Vercel Dashboard
2. Click **Redeploy** on the latest production deployment
3. Wait for deployment to complete

#### Step 4: Verify Fix

1. Check Sentry for new errors related to CSRF_TOKEN_SALT
2. Monitor application logs to ensure no validation errors
3. Test the application to confirm it's working correctly

### Environment Variables Reference

Complete list of required environment variables for production:

| Variable | Required | Description | Secure |
|----------|-----------|-------------|----------|
| `NEXT_PUBLIC_APP_URL` | Yes | Application URL | No |
| `NEXT_PUBLIC_TWITCH_CLIENT_ID` | Yes | Twitch Client ID (public) | No |
| `TWITCH_CLIENT_ID` | Yes | Twitch Client ID | Yes |
| `TWITCH_CLIENT_SECRET` | Yes | Twitch Client Secret | Yes |
| `TWITCH_EVENTSUB_SECRET` | Yes | Twitch EventSub webhook secret | Yes |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL | No |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous key | No |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key | Yes |
| `BLOB_READ_WRITE_TOKEN` | Yes | Vercel Blob storage token | Yes |
| **`CSRF_TOKEN_SALT`** | **Yes** | **CSRF protection salt (min 32 chars)** | **Yes** |
| `CSRF_SIGNING_KEY` | Yes | CSRF token signing key | Yes |

### Security Considerations

1. **Generate Fresh Salt:** Always generate a new, random salt. Never reuse values from examples.
2. **Keep It Secret:** The salt must be kept confidential and never committed to git.
3. **Minimum Length:** The salt must be at least 32 characters for cryptographic security.
4. **Unique Per Environment:** Use different salts for development, staging, and production.
5. **Rotation:** Consider rotating the salt periodically for enhanced security.

### Testing Locally

To test with CSRF_TOKEN_SALT locally, add to `.env.local`:

```bash
# Generate a new salt for local development
CSRF_TOKEN_SALT=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# Or add manually (minimum 32 characters)
CSRF_TOKEN_SALT=your-secure-salt-here-at-least-32-characters
```

### Monitoring

After fixing the issue:
- Monitor Sentry for any remaining CSRF validation errors
- Check application health and performance
- Ensure all endpoints are responding correctly
- Verify CSRF protection is working as expected

### Related Documentation

- [SECURITY.md](../SECURITY.md) - Security policies and CSRF protection
- [README.md](../README.md) - Environment variables reference
- [env-validation.ts](../src/lib/env-validation.ts) - Environment validation code

### Additional Notes

- The `CSRF_TOKEN_SALT` is validated at module initialization
- If the salt is missing or too short, the application fails to start
- This is intentional to prevent running with insecure CSRF configuration
- Test environments (`NODE_ENV=test` or `CI=true`) are exempt from this validation