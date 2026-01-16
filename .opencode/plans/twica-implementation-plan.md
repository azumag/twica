# Twica Implementation Plan

## 1. Overview

This plan addresses:
1. CI build failures (missing environment variables)
2. Lint errors preventing successful CI runs
3. Open Issue #3: CI/CD improvements
4. Open Issue #11: Storage architecture review

---

## 2. Priority 1: Fix CI Build Failures

### 2.1 Problem
CI build fails with error:
```
Error: Missing required environment variables: NEXT_PUBLIC_TWITCH_CLIENT_ID, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_EVENTSUB_SECRET, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

### 2.2 Root Cause
- Environment variables are referenced during build time but not set in CI workflow
- The build process validates environment variables and fails if missing
- Some secrets are missing from GitHub repository secrets

### 2.3 Solution Options

#### Option A: Add All Secrets to GitHub (Recommended)
- Add all missing environment variables as GitHub Secrets
- Update `.github/workflows/ci.yml` to include all required variables
- Pros: Full build validation in CI, production-like environment
- Cons: Requires manual secret setup

#### Option B: Use Mock Environment Variables
- Add dummy values for non-critical variables in CI
- Add environment variable validation that allows build with dummy values
- Pros: No manual secret setup
- Cons: Doesn't validate actual environment configuration

#### Option C: Separate Build and Validation
- Build without strict environment variable validation
- Add separate validation step that can skip in CI
- Pros: Faster CI, no secret dependency
- Cons: Build errors discovered later

### 2.4 Decision: **Option A**
Add all required secrets to GitHub and update CI workflow.

---

## 3. Priority 1: Fix Lint Errors

### 3.1 Issues Found

#### File: `tests/api/upload.test.js`
- Lines 1-3: Using `require()` style imports (forbidden)
- Line 5: `API_URL` assigned but never used
- Lines 83, 315, 334: Variables defined but never used

#### File: `scripts/get-test-session.js`
- Line 9: Using `require()` style import (forbidden)
- Lines 83, 89: Variables defined but never used

#### File: `e2e/fixtures/auth.ts`
- Line 86: React Hook "use" called in function "page" that's not a React component
- Line 1: `expect` imported but never used

### 3.2 Solution
1. Convert all `require()` imports to ES6 `import` statements
2. Remove unused variables
3. Fix React Hook usage in Playwright fixtures

---

## 4. Priority 2: Address Open Issue #3 (CI/CD)

### 4.1 Issue Requirements
- PR時のlintとテスト (Linting and testing for PRs)
- マージ時の自動デプロイを設定したい (Auto-deploy on merge)
- mainマージで本番環境デプロイ (Deploy to production on main merge)

### 4.2 Current State
- CI workflow exists for `main` branch and PRs
- Runs: lint, build (no tests)
- No auto-deployment configured
- Vercel has auto-deployment but not through GitHub Actions

### 4.3 Proposed CI/CD Improvements

#### Workflow Structure
```yaml
# .github/workflows/ci.yml
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  # PR: Lint, Type Check, Unit Tests, E2E Tests
  # Push: Lint, Build, Deploy
```

#### Test Strategy
1. **Unit Tests**: Run with Vitest (fast, < 10s)
2. **E2E Tests**: Run with Playwright on PRs (comprehensive, but slower)
3. **Build Validation**: Ensure production build works

#### Deployment Strategy
- Vercel auto-deploys on push to `main` (already configured)
- Add GitHub Actions job to trigger Vercel deployment
- Use Vercel CLI or API for deployment control

### 4.4 Implementation Steps
1. Update `.github/workflows/ci.yml` with:
   - Separate jobs for lint, type-check, test, build
   - Job dependencies (lint → type-check → test → build)
   - Deployment step for `main` branch
2. Add test execution to CI workflow
3. Add type checking step (`npm run typecheck` or `tsc --noEmit`)
4. Add E2E test step (PRs only)
5. Configure Vercel deployment through GitHub Actions

---

## 5. Priority 3: Address Open Issue #11 (Storage Architecture)

### 5.1 Issue Description
- Image upload capacity limit: 5MB total
- Supabase Storage limit: 1GB free tier
- Only ~200 users can be supported (5MB * 200 = 1GB)
- Suggestion: Consider using blob storage

### 5.2 Current Storage Implementation
- **Supabase Storage**: Used for image uploads
- **Vercel Blob**: Token exists (`BLOB_READ_WRITE_TOKEN`) but marked as "to be deprecated"
- **Image Size Limit**: 2MB per card, 5MB total per streamer

### 5.3 Storage Options Comparison

| Option | Cost | Scalability | Pros | Cons |
|--------|------|-------------|------|------|
| **Supabase Storage (Current)** | Free tier 1GB, $0.021/GB after | Medium | Integrated with DB, already implemented | Limited free tier |
| **Vercel Blob** | $0.15/GB (no free tier) | High | Native Next.js integration, automatic CDN | Higher cost |
| **Cloudflare R2** | Free tier 10GB, $0.015/GB after | Very High | Cheap, S3-compatible | Setup complexity |
| **AWS S3** | $0.023/GB, $0.0004/1000 requests | Very High | Industry standard | Setup complexity |

### 5.4 Capacity Analysis

#### Scenario 1: Keep Supabase Storage
- **Free tier**: 1GB
- **Users supported**: 200 users (5MB/user)
- **Scaling cost**: $0.021/GB after 1GB
- **User cost**: ~$0.01/user/month at scale

#### Scenario 2: Migrate to Vercel Blob
- **No free tier**: $0.15/GB
- **Users supported**: 200 users = 1GB = $0.15/month
- **User cost**: ~$0.075/user/month at scale

#### Scenario 3: Migrate to Cloudflare R2
- **Free tier**: 10GB
- **Users supported**: 2,000 users (5MB/user)
- **Scaling cost**: $0.015/GB after 10GB
- **User cost**: ~$0.0075/user/month at scale

### 5.5 Recommendation

#### Phase 1 (Current): Optimize Supabase Storage
- Implement image compression before upload
- Add usage monitoring and alerts
- Implement storage quotas per user
- Cost: Low, immediate

#### Phase 2 (When > 150 users): Migrate to Cloudflare R2
- Better free tier (10GB vs 1GB)
- Lower cost at scale ($0.015/GB vs $0.021/GB)
- S3-compatible API, easy migration
- Cost: Medium, one-time migration effort

#### Phase 3 (When > 2,000 users): Multi-region CDN
- Consider Cloudflare Images or dedicated CDN
- Cost: High, requires significant infrastructure

### 5.6 Implementation Plan for Phase 1
1. **Image Compression**: Add compression before upload (target: 50% reduction)
2. **Storage Quotas**: Implement per-user storage limits
3. **Usage Monitoring**: Add dashboard for storage usage
4. **Alerts**: Notify when approaching limits

---

## 6. Implementation Timeline

### Week 1: CI/CD Fixes (High Priority)
- [ ] Add missing GitHub Secrets
- [ ] Fix lint errors in test files
- [ ] Update CI workflow with all required environment variables
- [ ] Verify CI passes

### Week 2: CI/CD Improvements (High Priority)
- [ ] Add unit tests to CI workflow
- [ ] Add E2E tests to PR workflow
- [ ] Add type checking step
- [ ] Configure Vercel deployment through GitHub Actions
- [ ] Update `.github/workflows/ci.yml`

### Week 3: Storage Optimization (Medium Priority)
- [ ] Implement image compression
- [ ] Add storage usage monitoring
- [ ] Implement storage quotas
- [ ] Create storage usage dashboard

### Week 4: Migration Planning (Low Priority)
- [ ] Create migration plan for Cloudflare R2
- [ ] Set up Cloudflare R2 account
- [ ] Implement migration script
- [ ] Test migration with test data

---

## 7. Detailed Implementation Plan

### 7.1 Fix CI Build Failures

#### Step 1: Update CI Workflow
Update `.github/workflows/ci.yml` to include all required environment variables:

```yaml
- name: Build
  run: npm run build
  env:
    NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}
    NEXT_PUBLIC_TWITCH_CLIENT_ID: ${{ secrets.NEXT_PUBLIC_TWITCH_CLIENT_ID }}
    TWITCH_CLIENT_ID: ${{ secrets.TWITCH_CLIENT_ID }}
    TWITCH_CLIENT_SECRET: ${{ secrets.TWITCH_CLIENT_SECRET }}
    TWITCH_EVENTSUB_SECRET: ${{ secrets.TWITCH_EVENTSUB_SECRET }}
    SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    NEXT_PUBLIC_APP_URL: http://localhost:3000
```

#### Step 2: Add GitHub Secrets
The following secrets need to be added to GitHub repository:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `TWITCH_EVENTSUB_SECRET`

### 7.2 Fix Lint Errors

#### Step 1: Convert `tests/api/upload.test.js`
- Replace `require()` with ES6 `import`
- Remove unused `API_URL` variable
- Remove unused error variables

#### Step 2: Convert `scripts/get-test-session.js`
- Replace `require()` with ES6 `import`
- Remove unused error variables
- Fix parameter naming

#### Step 3: Fix `e2e/fixtures/auth.ts`
- Remove unused `expect` import
- Fix React Hook usage (already using Playwright's `use`, which is correct)
- Verify no actual React Hook violations

### 7.3 Improve CI/CD

#### Step 1: Update `.github/workflows/ci.yml`
```yaml
name: CI/CD

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint

  type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx tsc --noEmit

  test-unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run test:unit

  test-e2e:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npm run test:e2e

  build:
    runs-on: ubuntu-latest
    needs: [lint, type-check]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      env:
        NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY }}
        NEXT_PUBLIC_TWITCH_CLIENT_ID: ${{ secrets.NEXT_PUBLIC_TWITCH_CLIENT_ID }}
        TWITCH_CLIENT_ID: ${{ secrets.TWITCH_CLIENT_ID }}
        TWITCH_CLIENT_SECRET: ${{ secrets.TWITCH_CLIENT_SECRET }}
        TWITCH_EVENTSUB_SECRET: ${{ secrets.TWITCH_EVENTSUB_SECRET }}
        SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        NEXT_PUBLIC_APP_URL: http://localhost:3000

  deploy:
    runs-on: ubuntu-latest
    needs: [build]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'
```

#### Step 2: Add Type Check Script
Update `package.json`:
```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    ...
  }
}
```

### 7.4 Storage Optimization

#### Step 1: Implement Image Compression
Add image compression before upload using `sharp`:

```typescript
// lib/image-compression.ts
import sharp from 'sharp';

export async function compressImage(
  buffer: Buffer,
  maxSizeMB: number = 0.5 // 0.5MB target
): Promise<Buffer> {
  const targetSize = maxSizeMB * 1024 * 1024;

  let compressed = await sharp(buffer)
    .jpeg({ quality: 80, progressive: true })
    .toBuffer();

  // If still too large, reduce quality further
  let quality = 80;
  while (compressed.length > targetSize && quality > 50) {
    quality -= 10;
    compressed = await sharp(buffer)
      .jpeg({ quality, progressive: true })
      .toBuffer();
  }

  return compressed;
}
```

#### Step 2: Add Storage Monitoring
Create API endpoint to check storage usage:

```typescript
// app/api/storage-usage/route.ts
export async function GET(req: Request) {
  const supabase = getSupabaseAdmin();
  const { data: streamer } = await getStreamer(req);

  const { data: cards } = await supabase
    .from('cards')
    .select('image_url')
    .eq('streamer_id', streamer.id);

  const totalSize = await calculateTotalImageSize(cards);
  const quota = 5 * 1024 * 1024; // 5MB
  const usage = (totalSize / quota) * 100;

  return Response.json({ totalSize, quota, usage });
}
```

#### Step 3: Implement Storage Quotas
Update card upload API to check quotas:

```typescript
// app/api/upload/route.ts
export async function POST(req: Request) {
  const supabase = getSupabaseAdmin();
  const streamer = await getStreamer(req);

  // Check storage quota
  const usage = await getStorageUsage(streamer.id);
  if (usage >= 5 * 1024 * 1024) {
    return Response.json(
      { error: 'Storage quota exceeded (5MB limit)' },
      { status: 400 }
    );
  }

  // Process upload
  ...
}
```

---

## 8. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| GitHub Secrets exposure | High | Use GitHub Actions secrets, audit access |
| CI/CD pipeline fails | High | Test in staging first, gradual rollout |
| Storage migration data loss | High | Backup before migration, test with sample data |
| Image compression reduces quality | Medium | Target 80% quality, user feedback loop |
| Storage quota blocks users | Medium | Clear UI feedback, upgrade path |

---

## 9. Acceptance Criteria

### CI/CD Fixes
- [ ] CI workflow passes without errors
- [ ] All lint errors are resolved
- [ ] Build succeeds with all environment variables

### CI/CD Improvements
- [ ] PR workflow runs: lint, type-check, test-unit, test-e2e, build
- [ ] Main branch workflow runs: lint, type-check, build, deploy
- [ ] Deployment to Vercel production works automatically
- [ ] Failed workflows send notifications

### Storage Optimization
- [ ] Images are compressed before upload (target: <500KB per image)
- [ ] Storage usage is displayed in dashboard
- [ ] Storage quota prevents uploads over 5MB
- [ ] Users receive warnings when approaching quota (80%, 90%, 100%)

---

## 10. Next Steps

1. **Immediate**: Add GitHub Secrets and update CI workflow
2. **Today**: Fix lint errors in test files
3. **This Week**: Improve CI/CD workflow with tests
4. **Next Week**: Implement storage optimization

---

## 11. Dependencies

- GitHub repository access for secrets management
- Vercel account for deployment configuration
- Cloudflare R2 account (Phase 2)
- `sharp` package for image compression

---

**Plan Version**: 1.0
**Created**: 2026-01-17
**Status**: Ready for Implementation
